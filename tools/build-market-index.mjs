#!/usr/bin/env node
/**
 * Adds or refreshes one version entry in `market/index.json` (DSH plugin market,
 * format 1) so the published index points at an exact, commit-pinned release.
 *
 *   node tools/build-market-index.mjs --commit <40-hex-sha> --version 1.0.1
 *   node tools/build-market-index.mjs --commit <sha> --version 1.0.1 \
 *        --validate /path/to/dsh-plugin-market-index/lib/index.js
 *
 * `--validate` runs DSH's own validator over the result (the file extracted from
 * `app.asar` with `tools/asar-extract.cjs`; it needs `semver` resolvable next to
 * it). Without it the document is still written, just not schema-checked.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_PATH = join(ROOT, 'market', 'index.json')

const REPO = 'https://github.com/shengpj/dsh-payload'
const INDEX_URL = 'https://raw.githubusercontent.com/shengpj/dsh-payload/main/market/index.json'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`)
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    args[key] = value
    i += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.commit || !args.version) {
  throw new Error('usage: build-market-index.mjs --commit <sha> --version <semver> [--timestamp <unix>] [--validate <validator.mjs>]')
}
if (!/^[0-9a-f]{40}$/u.test(args.commit)) throw new Error('--commit must be a lowercase 40-hex-digit SHA')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(args.version)) throw new Error('--version must be an exact SemVer version')

const publishTimestamp = args.timestamp === undefined
  ? Math.floor(Date.now() / 1000)
  : Number(args.timestamp)

const doc = existsSync(INDEX_PATH)
  ? JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
  : {
      format: 1,
      title: { en: 'shengpj DSH plugins', zh: 'shengpj 的 DSH 插件' },
      description: {
        en: 'Plugins for DeepSeek Harness maintained by shengpj.',
        zh: 'shengpj 维护的 DeepSeek Harness 插件。',
      },
      metadata: {
        categories: { diagnostics: { title: { en: 'Diagnostics', zh: '诊断' } } },
        labels: { 'client-only': { title: { en: 'Client-only', zh: '纯客户端' } } },
        sortKeys: {},
      },
      plugins: [],
    }

let plugin = doc.plugins.find((entry) => entry.name === 'dsh-payload')
if (plugin === undefined) {
  plugin = {
    name: 'dsh-payload',
    title: { en: 'Payload inspector', zh: '请求 JSON 查看器' },
    description: {
      en: 'Adds a { } button to every assistant reply in the DSH Web GUI and shows the exact request that produced it: model, call parameters, messages, tools, and provider-reported token usage.',
      zh: '在 DSH Web GUI 的每条 assistant 回复下方加一个 { } 按钮，点开可以看到产生这条回复的那次调用实际发给模型的完整请求：model、调用参数、messages、tools，以及 provider 上报的 token 用量。',
    },
    author: 'shengpj',
    homepage: `${REPO}#readme`,
    repository: { url: REPO },
    metadata: { category: 'diagnostics', keywords: ['payload', 'request', 'json', 'inspector', 'debug', 'token'], labels: ['client-only'] },
    versions: [],
  }
  doc.plugins.push(plugin)
}

plugin.versions = plugin.versions.filter((entry) => entry.version !== args.version)
plugin.versions.push({
  version: args.version,
  publishTimestamp,
  source: { type: 'git', url: REPO, commit: args.commit },
})
plugin.versions.sort((left, right) => compareSemver(right.version, left.version))

/** Precedence comparison for the `x.y.z[-pre]` versions this file uses. */
function compareSemver(left, right) {
  const [leftCore, leftPre] = left.split('-')
  const [rightCore, rightPre] = right.split('-')
  const leftParts = leftCore.split('.').map(Number)
  const rightParts = rightCore.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (leftParts[i] !== rightParts[i]) return leftParts[i] - rightParts[i]
  }
  if (leftPre === rightPre) return 0
  if (leftPre === undefined) return 1
  if (rightPre === undefined) return -1
  return leftPre.localeCompare(rightPre)
}

writeFileSync(INDEX_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log(`market/index.json: dsh-payload ${plugin.versions.map((entry) => entry.version).join(', ')}`)

if (args.validate !== undefined) {
  const { parseMarketIndex, marketInstallTarget } = await import(pathToFileURL(args.validate).href)
  const parsed = parseMarketIndex(JSON.parse(readFileSync(INDEX_PATH, 'utf8')), INDEX_URL)
  const entry = parsed.plugins[0]
  const newest = entry.versions[0]
  console.log(`validated OK — newest ${entry.name}@${newest.version}, install ${marketInstallTarget(entry.name, newest).spec}`)
}

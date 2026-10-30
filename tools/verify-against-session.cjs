// verify-against-session.js — drive the real client.js pipeline against a real
// session log, without a browser.
//
//   node tools/verify-against-session.js [session.v4.jsonl.zstd]
//
// With no argument it picks the most recently written session log under
// %USERPROFILE%\.dsh\sessions. It reports, per Turn, how many model calls the
// plugin reconstructs, and prints the first call of the newest Turn in full so
// the payload can be eyeballed against the model's real request shape.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PLUGIN = path.join(__dirname, '..', 'client.js');

function newestSessionLog() {
  const root = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'sessions');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (/\.jsonl(\.zstd)?$/.test(item.name)) {
        try {
          found.push({ full, mtime: fs.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].full : null;
}

// ---- 1. read the log (it is a multi-frame zstd stream: split on magic bytes)
function loadEvents(file) {
  let text;
  if (file.endsWith('.zstd')) {
    const raw = fs.readFileSync(file);
    const offsets = [];
    for (let i = 0; i + 4 <= raw.length; i += 1) {
      if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i);
    }
    const chunks = [];
    for (let k = 0; k < offsets.length; k += 1) {
      const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length;
      try {
        chunks.push(zlib.zstdDecompressSync(raw.subarray(offsets[k], end)).toString('utf8'));
      } catch {}
    }
    text = chunks.join('');
  } else {
    text = fs.readFileSync(file, 'utf8');
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && typeof event.seq === 'number')
    .sort((a, b) => a.seq - b.seq);
}

// ---- 2. load the plugin the way the browser does (window.__ModuleLoader__)
function loadPlugin() {
  let mod = null;
  globalThis.__DSH_PAYLOAD_TEST__ = true;
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        mod = factory(() => ({}));
      },
    },
  };
  const src = fs.readFileSync(PLUGIN, 'utf8');
  new Function('window', src)(globalThis.window);
  if (!mod) throw new Error('plugin did not register through window.__ModuleLoader__');
  const api = globalThis.__DSH_PAYLOAD_INTERNALS__;
  if (!api) throw new Error('internals hook missing');
  return api;
}

const log = process.argv[2] || newestSessionLog();
if (!log) {
  console.error('no session log found');
  process.exit(1);
}
console.log('log: ' + log);

const events = loadEvents(log);
console.log('events: ' + events.length);

const api = loadPlugin();
const flat = api.collectEvents(events.map((event) => ({ type: 'event', event })));
console.log('surface events: ' + flat.length);

/* Ground truth: the provider-reported usage of every answered call, per Turn. */
const logUsage = {};
for (const event of events) {
  if (event.type !== 'assistant/message') continue;
  const data = event.data || {};
  const usage = data.usage;
  if (!usage || typeof usage.totalTokens !== 'number') continue;
  const key = String(data.turn);
  logUsage[key] = (logUsage[key] || 0) + usage.totalTokens;
}

const counts = {};
let newest = null;
for (const start of flat.filter((event) => event.type === 'turn/start')) {
  const turn = start.data.turn;
  const built = api.buildTurnCalls(flat, turn, undefined, start.seq);
  const calls = (built && built.calls) || [];
  counts[turn] = calls.length;
  const sample = calls[calls.length - 1];
  let rebuilt = 0;
  let missing = 0;
  for (const item of calls) {
    if (item.meta && item.meta.usage && typeof item.meta.usage.total === 'number') rebuilt += item.meta.usage.total;
    else missing += 1;
  }
  const expected = logUsage[String(turn)] || 0;
  const verdict = rebuilt === expected ? 'ok' : 'MISMATCH';
  console.log(
    'Turn ' + String(turn).padStart(2) + ' -> ' + String(calls.length).padStart(3) + ' call(s)' +
      (sample
        ? '  last: msgs=' + sample.request.messages.length +
          ' tools=' + sample.request.tools.length +
          ' model=' + sample.meta.model
        : '') +
      '  tokens=' + rebuilt + ' vs log=' + expected + ' ' + verdict +
      (missing ? ' (no usage on ' + missing + ' call(s))' : ''),
  );
  if (calls.length) newest = { turn, call: sample };
}

if (newest) {
  console.log('\n=== Turn ' + newest.turn + ' last call: request keys ===');
  console.log(JSON.stringify(Object.keys(newest.call.request)));
  console.log('usage: ' + JSON.stringify(newest.call.meta.usage));
  console.log('\n=== messages (role, tool_calls, content head) ===');
  newest.call.request.messages.forEach((message, index) => {
    const head =
      typeof message.content === 'string'
        ? message.content.replace(/\s+/g, ' ').slice(0, 70)
        : JSON.stringify(message.content).slice(0, 70);
    console.log(
      String(index).padStart(2) + ' ' + message.role.padEnd(9) +
        (message.tool_calls ? 'tc=' + message.tool_calls.length + ' ' : '') + head,
    );
  });
}

/* The per-message button starts from a durable message id, so prove that every
   assistant message resolves to exactly one rebuilt call, on its own step. */
const builtByTurn = {};
let mapped = 0;
let unmapped = 0;
const bad = [];
for (const event of flat) {
  if (event.type !== 'assistant/message') continue;
  const id = event.data && event.data.message && event.data.message.id;
  if (!id) continue;
  const spot = api.locateMessage(flat, id);
  if (!spot) {
    unmapped += 1;
    bad.push({ id, why: 'locateMessage returned null' });
    continue;
  }
  if (!builtByTurn[spot.turn]) {
    builtByTurn[spot.turn] = api.buildTurnCalls(flat, spot.turn) || { calls: [] };
  }
  const built = builtByTurn[spot.turn];
  const index = api.callIndexForStep(built, spot.step);
  const call = built.calls[index];
  if (!call) {
    unmapped += 1;
    bad.push({ id, why: 'Turn ' + spot.turn + ' rebuilt no calls' });
    continue;
  }
  const callStep = call.meta && call.meta.step;
  if (callStep !== spot.step) {
    bad.push({ id, why: 'step ' + spot.step + ' resolved to call of step ' + callStep });
    continue;
  }
  mapped += 1;
}

console.log(
  '\n=== message -> call mapping: ' + mapped + ' mapped, ' + unmapped + ' unmapped, ' +
    bad.length + ' problem(s) ===',
);
for (const item of bad.slice(0, 10)) console.log('  ' + item.id + ': ' + item.why);
if (!bad.length) console.log('  every assistant message resolves to its own step call');


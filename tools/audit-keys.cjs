/* Static audit: every STYLE/TEXT key must be referenced somewhere in client.js. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

/* Every block ends where the NEXT top-level `const` begins, never at a hard-coded
   marker that a later refactor can move above the block it was meant to close.
   Getting that wrong silently reports another table's keys as dead styles. */
function blockOf(startMarker) {
  const from = src.indexOf(startMarker);
  if (from < 0) return '';
  const rest = src.slice(from + startMarker.length);
  const end = rest.search(/^ {4}(?:const|let|function) /m);
  return end < 0 ? rest : rest.slice(0, end);
}

function keysOf(startMarker) {
  return [...blockOf(startMarker).matchAll(/^ {6}(['"]?)([A-Za-z][A-Za-z-]*)\1:/gm)].map((m) => m[2]);
}

const styleKeys = keysOf('const STYLE = {');
/* `TEXT` is a `ZH ? {...} : {...}` pair, so both branches count: a key is only
   dead when neither language branch is ever read. */
const textKeys = [
  ...new Set(
    src
      .slice(src.indexOf('const TEXT ='), src.indexOf('const FONT_MONO'))
      .split(/\r?\n/)
      .filter((line) => /^ {10}[A-Za-z][A-Za-z]*:/.test(line))
      .map((line) => line.trim().split(':')[0]),
  ),
];

/* A missing key is worse than a dead one: `TEXT.nope` renders the literal string
   "undefined" in the UI instead of failing. The two dictionaries are the ZH and
   EN halves of `ZH ? {...} : {...}`, so both are checked against every read. */
const textLines = src.split(/\r?\n/);
const textFrom = textLines.findIndex((line) => /const TEXT = ZH/.test(line));
const branchStart = []; // indexes of the `? {` / `: {` lines that open a branch
for (let index = textFrom; index < textFrom + 400; index += 1) {
  const line = textLines[index] || '';
  if (/^\s+\? \{\s*$/.test(line) || /^\s+: \{\s*$/.test(line)) branchStart.push(index + 1);
  if (/^\s+\};\s*$/.test(line)) break;
}
const dictNames = ['zh', 'en'];
const reads = [...new Set([...src.matchAll(/TEXT\.([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
branchStart.forEach((from, index) => {
  const present = new Set();
  for (let line = from; line < textLines.length; line += 1) {
    if (/^\s+\};?\s*$/.test(textLines[line])) break;
    const hit = /^\s+([A-Za-z][A-Za-z0-9_]*):/.exec(textLines[line]);
    if (hit) present.add(hit[1]);
  }
  for (const key of reads) {
    if (!present.has(key)) console.log('MISSING text (' + (dictNames[index] || index) + '):', key);
  }
});

/* `SOURCE_KINDS` is a lookup table, not a style/text block, but it lives at the
   same indentation; its keys are read as `SOURCE_KINDS[kind]`, so require the
   same dotted form or a bracket lookup before calling a key dead. */
for (const key of styleKeys) {
  const hits = src.split('STYLE.' + key).length - 1;
  if (hits === 0) console.log('DEAD style:', key);
}
for (const key of textKeys) {
  const hits = src.split('TEXT.' + key).length - 1;
  if (hits === 0) console.log('DEAD text:', key);
}
console.log('styles=' + styleKeys.length + ' texts=' + textKeys.length);

const declared = new Set([...src.matchAll(/className: '([^']+)'/g)].flatMap((m) => m[1].split(/\s+/)));
const cssClasses = new Set(
  [...src.matchAll(/\.dsh-pl-[a-z-]+/g)].map((m) => m[0].slice(1)),
);
for (const cls of ['dsh-pl-action', 'dsh-pl-icon', 'dsh-pl-tip', 'dsh-pl-btn', 'dsh-pl-tab', 'dsh-pl-tab-on', 'dsh-pl-step', 'dsh-pl-step-on']) {
  console.log(cls + ' used=' + src.split(cls).length + ' css=' + cssClasses.has(cls));
}

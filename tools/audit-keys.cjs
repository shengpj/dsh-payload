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

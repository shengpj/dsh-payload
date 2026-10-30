/* Static audit: every STYLE/TEXT key must be referenced somewhere in client.js. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8');

function keysOf(startMarker, endMarker) {
  const block = src.slice(src.indexOf(startMarker), src.indexOf(endMarker));
  return [...block.matchAll(/^ {6}([A-Za-z]+):/gm)].map((m) => m[1]);
}

const styleKeys = keysOf('const STYLE = {', 'const ACTION_STYLE_ID');
const textKeys = keysOf('const TEXT = {', 'const STYLE = {');

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

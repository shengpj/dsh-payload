/* Minimal ASAR reader: extract one file from an .asar archive without Electron. */
const fs = require('fs');
const path = require('path');

const archive = process.argv[2];
const inner = process.argv[3];
const outPath = process.argv[4];

const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const dataStart = 8 + headerSize;

let node = header;
for (const part of inner.split('/').filter(Boolean)) {
  node = node.files && node.files[part];
  if (!node) {
    console.error('not found: ' + part);
    process.exit(2);
  }
}
if (typeof node.link === 'string') {
  console.error('link entry (not handled): ' + node.link);
  process.exit(3);
}
const out = Buffer.alloc(node.size);
fs.readSync(fd, out, 0, node.size, dataStart + Number(node.offset));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(outPath + ' ' + node.size + ' bytes');

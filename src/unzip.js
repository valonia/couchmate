// Minimal zip extraction (no extra packages) for plugin zips.
// Handles ordinary zip files (stored or deflate-compressed). Refuses paths outside the folder.

import zlib from 'node:zlib';

const MAX_FILES = 500;
const MAX_TOTAL = 50 * 1024 * 1024;

/** @returns {{ name: string, data: Buffer }[]} */
export function unzip(buf) {
  // Slutet av den centrala katalogen (End Of Central Directory) ligger sist i filen.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The file is not a valid zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw new Error('The zip file contains too many files');
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Trasig zip-fil');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // mapp
    if (name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '') || /^[a-z]:/i.test(name)) {
      throw new Error(`Path not allowed in the zip file: ${name}`);
    }
    total += size;
    if (total > MAX_TOTAL) throw new Error('The zip file is too large when extracted');
    // Local file header: skip the name and extra field to find the data.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Trasig zip-fil');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`The compression in ${name} is not supported (save the zip file with ordinary compression)`);
    out.push({ name, data });
  }
  return out;
}

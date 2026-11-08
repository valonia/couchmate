// Minimal zip-uppackning (utan extra paket) för plugin-zippar.
// Stöder vanliga zip-filer (lagrade eller deflate-komprimerade filer). Skyddar mot sökvägar utanför mappen.

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
  if (eocd < 0) throw new Error('Filen är ingen giltig zip-fil');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw new Error('Zip-filen innehåller för många filer');
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
      throw new Error(`Otillåten sökväg i zip-filen: ${name}`);
    }
    total += size;
    if (total > MAX_TOTAL) throw new Error('Zip-filen är för stor uppackad');
    // Lokala filhuvudet: hoppa över namn och extra-fält för att hitta datan.
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Trasig zip-fil');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Komprimeringen i ${name} stöds inte (spara zip-filen med vanlig komprimering)`);
    out.push({ name, data });
  }
  return out;
}

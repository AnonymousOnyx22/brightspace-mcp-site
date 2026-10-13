// Replaces one file inside a zip (the .mcpb extension) without unpacking it.
// Every other entry is copied byte for byte; the new file is stored uncompressed.
import * as zlib from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(zip) {
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Not a zip file");
}

export function readEntry(zip, name) {
  for (const entry of centralEntries(zip)) {
    if (entry.name !== name) continue;
    const local = entry.localOffset;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + entry.compressedSize);
    return entry.method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
  }
  return null;
}

function centralEntries(zip) {
  const eocd = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad central directory");
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const size = 46 + nameLen + extraLen + commentLen;
    entries.push({
      record: zip.subarray(p, p + size),
      name: zip.toString("utf8", p + 46, p + 46 + nameLen),
      method: zip.readUInt16LE(p + 10),
      compressedSize: zip.readUInt32LE(p + 20),
      localOffset: zip.readUInt32LE(p + 42),
    });
    p += size;
  }
  return entries;
}

export function replaceEntry(zip, name, content) {
  const eocd = findEndOfCentralDirectory(zip);
  const cdStart = zip.readUInt32LE(eocd + 16);
  const entries = centralEntries(zip);
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  const ends = new Map(byOffset.map((e, i) => [e, i + 1 < byOffset.length ? byOffset[i + 1].localOffset : cdStart]));
  if (!entries.some((e) => e.name === name)) throw new Error(`${name} not found in zip`);

  const crc = crc32(content);
  const nameBuf = Buffer.from(name, "utf8");
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of byOffset) {
    let local;
    let record = Buffer.from(entry.record);
    if (entry.name === name) {
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0x0800, 6); // utf-8 names, no data descriptor
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt32LE(zip.readUInt32LE(entry.localOffset + 10), 10); // keep time/date
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(content.length, 18);
      header.writeUInt32LE(content.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);
      local = Buffer.concat([header, nameBuf, content]);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(content.length, 20);
      record.writeUInt32LE(content.length, 24);
    } else {
      local = zip.subarray(entry.localOffset, ends.get(entry));
    }
    record.writeUInt32LE(offset, 42);
    parts.push(local);
    central.push({ entry, record });
    offset += local.length;
  }
  // Keep the original central directory order.
  const order = new Map(entries.map((e, i) => [e, i]));
  central.sort((a, b) => order.get(a.entry) - order.get(b.entry));
  const cd = Buffer.concat(central.map((c) => c.record));
  const end = Buffer.from(zip.subarray(eocd));
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

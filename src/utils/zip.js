import fsp from 'fs/promises';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function toDosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  let year = d.getFullYear();
  if (year < 1980) {
    year = 1980;
  }
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

export async function createZip(outputPath, entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    const nameBuffer = Buffer.from(name, 'utf8');
    const dataBuffer = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf8');
    const { dosTime, dosDate } = toDosDateTime(entry.mtime || new Date());
    const crc = crc32(dataBuffer);
    const size = dataBuffer.length;

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    let p = 0;
    localHeader.writeUInt32LE(0x04034b50, p); p += 4; // Local file header signature
    localHeader.writeUInt16LE(20, p); p += 2; // Version needed
    localHeader.writeUInt16LE(0, p); p += 2; // Flags
    localHeader.writeUInt16LE(0, p); p += 2; // Compression (store)
    localHeader.writeUInt16LE(dosTime, p); p += 2;
    localHeader.writeUInt16LE(dosDate, p); p += 2;
    localHeader.writeUInt32LE(crc, p); p += 4;
    localHeader.writeUInt32LE(size, p); p += 4;
    localHeader.writeUInt32LE(size, p); p += 4;
    localHeader.writeUInt16LE(nameBuffer.length, p); p += 2;
    localHeader.writeUInt16LE(0, p); p += 2; // Extra length
    nameBuffer.copy(localHeader, p);

    fileParts.push(localHeader, dataBuffer);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    p = 0;
    centralHeader.writeUInt32LE(0x02014b50, p); p += 4; // Central dir signature
    centralHeader.writeUInt16LE(20, p); p += 2; // Version made by
    centralHeader.writeUInt16LE(20, p); p += 2; // Version needed
    centralHeader.writeUInt16LE(0, p); p += 2; // Flags
    centralHeader.writeUInt16LE(0, p); p += 2; // Compression
    centralHeader.writeUInt16LE(dosTime, p); p += 2;
    centralHeader.writeUInt16LE(dosDate, p); p += 2;
    centralHeader.writeUInt32LE(crc, p); p += 4;
    centralHeader.writeUInt32LE(size, p); p += 4;
    centralHeader.writeUInt32LE(size, p); p += 4;
    centralHeader.writeUInt16LE(nameBuffer.length, p); p += 2;
    centralHeader.writeUInt16LE(0, p); p += 2; // Extra length
    centralHeader.writeUInt16LE(0, p); p += 2; // Comment length
    centralHeader.writeUInt16LE(0, p); p += 2; // Disk number
    centralHeader.writeUInt16LE(0, p); p += 2; // Internal attributes
    centralHeader.writeUInt32LE(0, p); p += 4; // External attributes
    centralHeader.writeUInt32LE(offset, p); p += 4; // Local header offset
    nameBuffer.copy(centralHeader, p);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBuffer.length;
  }

  const centralDirSize = centralParts.reduce((sum, buf) => sum + buf.length, 0);
  const centralDirOffset = offset;
  const endRecord = Buffer.alloc(22);
  let e = 0;
  endRecord.writeUInt32LE(0x06054b50, e); e += 4; // End of central dir signature
  endRecord.writeUInt16LE(0, e); e += 2; // Disk number
  endRecord.writeUInt16LE(0, e); e += 2; // Central dir start disk
  endRecord.writeUInt16LE(entries.length, e); e += 2; // Entries on disk
  endRecord.writeUInt16LE(entries.length, e); e += 2; // Total entries
  endRecord.writeUInt32LE(centralDirSize, e); e += 4;
  endRecord.writeUInt32LE(centralDirOffset, e); e += 4;
  endRecord.writeUInt16LE(0, e); e += 2; // Comment length

  const buffer = Buffer.concat([...fileParts, ...centralParts, endRecord]);
  await fsp.writeFile(outputPath, buffer);
}

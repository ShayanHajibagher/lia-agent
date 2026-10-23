/**
 * zip.mjs — خواندن/نوشتن ZIP بدون وابستگی بیرونی
 *
 * چرا: کاربر «فایل zip پروژه» را آپلود می‌کند و ما باید فقط بخوانیم (بدون exec،
 * بدون کتابخانه). برای تست هم باید بتوانیم fixture بسازیم، پس نوشتن هم دارد.
 *
 * محافظت‌ها: سقف تعداد فایل، سقف حجم هر فایل و مجموع، و رد مسیرهای خطرناک
 * (zip-slip: `../` یا مسیر مطلق).
 */
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export const LIMITS = {
  maxEntries: 3000,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
};

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function safeName(name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((p) => p === '..')) return null;
  return normalized.replace(/^\.\//, '');
}

/**
 * @param {Buffer} buffer
 * @returns {{ name: string, data: Buffer, isDir: boolean }[]}
 */
export function readZip(buffer) {
  // پیدا کردن EOCD از انتها (کامنت ممکن است تا ۶۵۵۳۵ بایت باشد)
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('فایل ZIP معتبر نیست (EOCD پیدا نشد)');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > LIMITS.maxEntries) throw new Error(`تعداد فایل‌های zip بیش از حد مجاز است (${entryCount})`);

  const files = [];
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(p) !== SIG_CEN) throw new Error('ساختار central directory خراب است');
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const rawName = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const name = safeName(rawName);
    if (!name) continue; // مسیر خطرناک: نادیده بگیر

    if (uncompSize > LIMITS.maxEntryBytes) continue;
    total += uncompSize;
    if (total > LIMITS.maxTotalBytes) throw new Error('حجم باز‌شدهٔ zip بیش از حد مجاز است');

    const isDir = name.endsWith('/');
    if (isDir) {
      files.push({ name, data: Buffer.alloc(0), isDir: true });
      continue;
    }
    if (buffer.readUInt32LE(localOffset) !== SIG_LOC) continue;
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed, { maxOutputLength: LIMITS.maxEntryBytes });
    else continue; // روش فشرده‌سازی پشتیبانی‌نشده

    files.push({ name, data, isDir: false });
  }

  return files;
}

/**
 * @param {{ name: string, data: Buffer | string }[]} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);

    centrals.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

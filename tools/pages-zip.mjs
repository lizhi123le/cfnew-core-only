/**
 * 极简、确定性的 ZIP 读写（Node 自带 zlib，零依赖），用来生成 Cloudflare Pages 直传包。
 *
 * 为什么不用系统命令：
 *   - `Compress-Archive`（Windows）会写入本地文件时间、路径分隔符可能是 `\`；
 *   - `zip`（Linux）受 locale / 环境变量影响，产物不一定逐字节可重现。
 * 这里固定 DOS 时间戳（1980-01-01 00:00:00）与条目顺序，只要输入内容相同，
 * 同一 zlib 构建下的输出就完全一致。
 *
 * 注意：不同 zlib 构建的 deflate 字节可能有细微差别，所以 `build-kernel.mjs`
 * 校验 pages.zip 时比对的是「解包后的内容」而不是 zip 字节；内容没变时也不会重写它，
 * 避免 CI 因压缩器版本差异产生无意义的改动。
 */
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0：deflate
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** 标准 CRC-32（PNG/ZIP 用），返回无符号 32 位整数。 */
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toEntry(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.includes('\0')) {
    throw new Error(`ZIP 条目名不合法：${JSON.stringify(entry.name)}（必须是相对路径、用 / 分隔）`);
  }
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
  return { name, data, flags: /[^\x20-\x7e]/.test(entry.name) ? 0x0800 : 0 };
}

/**
 * 生成 ZIP（deflate 压缩）。
 * @param {{name: string, data: Buffer|string}[]} entries 条目按给定顺序写入
 * @param {{level?: number}} [options] deflate 压缩级别，默认 9
 * @returns {Buffer}
 */
export function createZip(entries, { level = 9 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('createZip 至少需要一个条目');
  const seen = new Set();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const raw of entries) {
    const { name, data, flags } = toEntry(raw);
    const key = name.toString('utf8');
    if (seen.has(key)) throw new Error(`ZIP 条目重复：${key}`);
    seen.add(key);

    const compressed = zlib.deflateRawSync(data, { level });
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    chunks.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIG, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    header.writeUInt16LE(VERSION_NEEDED, 6); // version needed
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk start
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(0, 38); // external attrs
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment

  return Buffer.concat([...chunks, centralBuffer, eocd]);
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('不是有效的 ZIP：找不到 EOCD 记录');
}

/**
 * 解析 ZIP（支持 store / deflate），返回 [{ name, data, size }]。
 * 只读不写，够用于校验本仓库自己生成的 pages.zip。
 */
export function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('不支持分卷 ZIP');
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== CENTRAL_SIG) throw new Error(`ZIP 中央目录损坏（第 ${i} 项）`);
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const checksum = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new Error(`不支持加密条目：${name}`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`ZIP 本地头损坏：${name}`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(start, start + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方法 ${method}（${name}）`);
    if (data.length !== size) throw new Error(`条目大小不符：${name}`);
    if (crc32(data) !== checksum) throw new Error(`条目 CRC 校验失败：${name}`);
    entries.push({ name, data, size: data.length });
  }
  return entries;
}

/** 取单个条目内容，不存在返回 null。 */
export function readZipEntry(buffer, name) {
  const found = readZipEntries(buffer).find((entry) => entry.name === name);
  return found ? found.data : null;
}

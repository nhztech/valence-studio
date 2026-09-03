import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const UTF8 = 0x0800;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[i] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeArchiveName(value) {
  const name = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = name.split("/");
  if (!name || name.startsWith("/") || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe archive path: ${value}`);
  }
  return name;
}

function header(size) {
  return Buffer.alloc(size);
}

/** Write a deterministic, ZIP-compatible .cart archive. */
export function writeCart(entries, outputFile) {
  const sorted = [...entries]
    .map((entry) => ({ name: safeArchiveName(entry.name), data: Buffer.from(entry.data) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const local = header(30);
    local.writeUInt32LE(LOCAL_FILE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); // deterministic DOS time
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = header(46);
    central.writeUInt32LE(CENTRAL_FILE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = header(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, Buffer.concat([...locals, ...centrals, end]));
}

/** Read and verify regular files from a ZIP-compatible .cart archive. */
export function readCart(inputFile) {
  const zip = fs.readFileSync(inputFile);
  let eocd = -1;
  const floor = Math.max(0, zip.length - 65557);
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("invalid .cart: ZIP directory not found");

  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;

  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_FILE) throw new Error("invalid .cart central directory");
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const encoding = flags & UTF8 ? "utf8" : "latin1";
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString(encoding);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (rawName.endsWith("/")) continue;
    const name = safeArchiveName(rawName);
    if (flags & 1) throw new Error(`encrypted .cart entry is unsupported: ${name}`);
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method for ${name}`);
    if (size > MAX_UNPACKED_BYTES || total + size > MAX_UNPACKED_BYTES) {
      throw new Error(".cart exceeds the 256 MiB unpacked safety limit");
    }
    if (zip.readUInt32LE(localOffset) !== LOCAL_FILE) throw new Error(`invalid local entry: ${name}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed);
    if (data.length !== size || crc32(data) !== checksum) throw new Error(`corrupt .cart entry: ${name}`);
    files.set(name, data);
    total += size;
  }
  return files;
}

export function extractCart(inputFile, outputDir, { force = false } = {}) {
  const files = readCart(inputFile);
  if (fs.existsSync(outputDir)) {
    if (!force) throw new Error(`output already exists: ${outputDir}`);
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const root = path.resolve(outputDir);
  for (const [name, data] of files) {
    const destination = path.resolve(root, ...name.split("/"));
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
      throw new Error(`archive path escapes output: ${name}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data);
  }
  return files.size;
}

export function collectProjectEntries(projectDir, roots) {
  const entries = [];
  function walk(absolute, archivePath) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in .cart: ${absolute}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(absolute, name), `${archivePath}/${name}`);
    } else if (stat.isFile()) {
      entries.push({ name: archivePath, data: fs.readFileSync(absolute) });
    }
  }
  for (const root of roots) {
    const absolute = path.join(projectDir, root);
    if (fs.existsSync(absolute)) walk(absolute, root);
  }
  return entries;
}

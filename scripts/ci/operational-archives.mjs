import { gunzipSync, inflateRawSync, crc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safePath, fail } from './operational-policy.mjs';
import { allocatedFootprint } from './operational-storage.mjs';

const text = bytes => bytes.toString('utf8').split('\0')[0];
export function tarEntries(bytes, limit) {
  const entries = [], seen = new Set();
  let offset = 0, expanded = 0, ended = false;
  while (offset + 512 <= bytes.length) {
    const h = bytes.subarray(offset, offset + 512); offset += 512;
    if (h.every(byte => byte === 0)) { ended = true; break; }
    const octal = field => {
      const value = text(field).trim();
      if (!/^[0-7]+$/.test(value)) fail('MALFORMED');
      return parseInt(value, 8);
    };
    const checksum = octal(h.subarray(148, 156));
    const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== sum) fail('MALFORMED');
    const prefix = text(h.subarray(345, 500));
    let path = (prefix ? prefix + '/' : '') + text(h.subarray(0, 100));
    if (path.endsWith('/')) path = path.slice(0, -1);
    const type = h[156], size = octal(h.subarray(124, 136));
    if (!safePath(path) || seen.has(path) || ![0, 48, 53].includes(type) ||
        (type === 53 && size !== 0) || size > limit || offset + size > bytes.length) fail('MALFORMED');
    seen.add(path); expanded += size;
    if (expanded > limit || entries.length >= 50000) fail('OVERFLOW');
    entries.push({ path, directory: type === 53, mode: octal(h.subarray(100, 108)),
      bytes: bytes.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || bytes.subarray(offset).some(byte => byte !== 0)) fail('MALFORMED');
  if (allocatedFootprint(entries.map(e => ({ path: e.path, size: e.bytes.length, directory: e.directory }))) > limit) fail('OVERFLOW');
  return entries;
}
export function tgzEntries(bytes, limit) {
  return tarEntries(gunzipSync(bytes, { maxOutputLength: limit + 32 * 1024 * 1024 }), limit);
}
export async function extractTgz(bytes, root, limit) {
  await writeEntries(tgzEntries(bytes, limit), root);
}
export function zipEntries(bytes, limit) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) ||
      end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) fail('MALFORMED');
  const count = bytes.readUInt16LE(end + 10), entries = [], seen = new Set();
  let cursor = bytes.readUInt32LE(end + 16), expanded = 0;
  if (count === 65535 || cursor + bytes.readUInt32LE(end + 12) !== end) fail('MALFORMED');
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('MALFORMED');
    const method = bytes.readUInt16LE(cursor + 10), flags = bytes.readUInt16LE(cursor + 8);
    const packed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    let path = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const directory = path.endsWith('/'); if (directory) path = path.slice(0, -1);
    if (!safePath(path) || seen.has(path) || flags & 1 || ![0, 8].includes(method) ||
        ![0, 0o100000, 0o040000].includes(mode & 0o170000) ||
        local + 30 > cursor || bytes.readUInt32LE(local) !== 0x04034b50) fail('MALFORMED');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > cursor || size > limit || expanded + size > limit) fail('OVERFLOW');
    const raw = bytes.subarray(start, start + packed);
    const data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    if (data.length !== size || crc32(data) !== bytes.readUInt32LE(cursor + 16)) fail('MALFORMED');
    entries.push({ path, directory, mode, bytes: data }); seen.add(path); expanded += size;
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) fail('MALFORMED');
  if (allocatedFootprint(entries.map(e => ({ path: e.path, size: e.bytes.length, directory: e.directory }))) > limit) fail('OVERFLOW');
  return entries;
}
export async function writeEntries(entries, root) {
  const files = new Set(entries.filter(e => !e.directory).map(e => e.path));
  for (const entry of entries) {
    for (let parent = dirname(entry.path); parent !== '.'; parent = dirname(parent)) {
      if (files.has(parent.replaceAll('\\', '/'))) fail('MALFORMED');
    }
    const target = join(root, entry.path);
    await mkdir(entry.directory ? target : dirname(target), { recursive: true, mode: 0o700 });
    if (!entry.directory) await writeFile(target, entry.bytes, {
      flag: 'wx', mode: entry.mode & 0o111 ? 0o755 : 0o644,
    });
  }
}

import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { once } from "node:events";
import type { Writable } from "node:stream";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const MAX_EOCD_SEARCH = 22 + 0xffff + 20;

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

export function updateCrc32(current: number, chunk: Uint8Array) {
  let crc = current ^ 0xffffffff;
  for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(data: Uint8Array) {
  return updateCrc32(0, data);
}

function toSafeNumber(value: bigint, label: string) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the supported filesystem range`);
  }
  return Number(value);
}

function createZip64Extra(values: bigint[]) {
  const payload = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => payload.writeBigUInt64LE(value, index * 8));
  const extra = Buffer.alloc(4 + payload.length);
  extra.writeUInt16LE(ZIP64_EXTRA_FIELD, 0);
  extra.writeUInt16LE(payload.length, 2);
  payload.copy(extra, 4);
  return extra;
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

async function writeBuffer(output: Writable, data: Buffer) {
  if (!output.write(data)) await once(output, "drain");
}

export type ZipSource =
  | { kind: "buffer"; data: Buffer }
  | { kind: "file"; path: string };

export type ZipWriteEntry = {
  name: string;
  size: bigint;
  crc32: number;
  source: ZipSource;
  modifiedAt?: Date;
};

type CentralEntry = {
  name: Buffer;
  crc32: number;
  size: bigint;
  localOffset: bigint;
  modifiedAt: Date;
};

export class ZipWriter {
  private offset = 0n;
  private readonly entries: CentralEntry[] = [];

  constructor(private readonly output: Writable) {}

  private async write(data: Buffer) {
    await writeBuffer(this.output, data);
    this.offset += BigInt(data.length);
  }

  async add(entry: ZipWriteEntry) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    if (!name.length || name.length > UINT16_MAX) throw new Error("ZIP entry name is invalid");
    if (entry.size < 0n) throw new Error("ZIP entry size is invalid");

    const localOffset = this.offset;
    const zip64 = entry.size >= BigInt(UINT32_MAX);
    const extra = zip64 ? createZip64Extra([entry.size, entry.size]) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    const { time, date } = dosDateTime(entry.modifiedAt ?? new Date());
    header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(STORE_METHOD, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(entry.crc32 >>> 0, 14);
    header.writeUInt32LE(zip64 ? UINT32_MAX : Number(entry.size), 18);
    header.writeUInt32LE(zip64 ? UINT32_MAX : Number(entry.size), 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([header, name, extra]));

    let written = 0n;
    if (entry.source.kind === "buffer") {
      await this.write(entry.source.data);
      written = BigInt(entry.source.data.length);
    } else {
      for await (const chunk of createReadStream(entry.source.path)) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await this.write(data);
        written += BigInt(data.length);
      }
    }
    if (written !== entry.size) throw new Error(`ZIP source size changed while exporting: ${entry.name}`);

    this.entries.push({
      name,
      crc32: entry.crc32 >>> 0,
      size: entry.size,
      localOffset,
      modifiedAt: entry.modifiedAt ?? new Date()
    });
  }

  async finalize() {
    const centralOffset = this.offset;
    let requiresZip64 = false;

    for (const entry of this.entries) {
      const sizeZip64 = entry.size >= BigInt(UINT32_MAX);
      const offsetZip64 = entry.localOffset >= BigInt(UINT32_MAX);
      const zip64Values: bigint[] = [];
      if (sizeZip64) zip64Values.push(entry.size, entry.size);
      if (offsetZip64) zip64Values.push(entry.localOffset);
      const extra = zip64Values.length ? createZip64Extra(zip64Values) : Buffer.alloc(0);
      const header = Buffer.alloc(46);
      const { time, date } = dosDateTime(entry.modifiedAt);
      header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
      header.writeUInt16LE(45, 4);
      header.writeUInt16LE(sizeZip64 || offsetZip64 ? 45 : 20, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(STORE_METHOD, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(sizeZip64 ? UINT32_MAX : Number(entry.size), 20);
      header.writeUInt32LE(sizeZip64 ? UINT32_MAX : Number(entry.size), 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(offsetZip64 ? UINT32_MAX : Number(entry.localOffset), 42);
      await this.write(Buffer.concat([header, entry.name, extra]));
      requiresZip64 ||= sizeZip64 || offsetZip64;
    }

    const centralSize = this.offset - centralOffset;
    requiresZip64 ||=
      this.entries.length >= UINT16_MAX ||
      centralOffset >= BigInt(UINT32_MAX) ||
      centralSize >= BigInt(UINT32_MAX);

    if (requiresZip64) {
      const zip64Offset = this.offset;
      const zip64 = Buffer.alloc(56);
      zip64.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY, 0);
      zip64.writeBigUInt64LE(44n, 4);
      zip64.writeUInt16LE(45, 12);
      zip64.writeUInt16LE(45, 14);
      zip64.writeUInt32LE(0, 16);
      zip64.writeUInt32LE(0, 20);
      zip64.writeBigUInt64LE(BigInt(this.entries.length), 24);
      zip64.writeBigUInt64LE(BigInt(this.entries.length), 32);
      zip64.writeBigUInt64LE(centralSize, 40);
      zip64.writeBigUInt64LE(centralOffset, 48);
      await this.write(zip64);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(zip64Offset, 8);
      locator.writeUInt32LE(1, 16);
      await this.write(locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(requiresZip64 ? UINT16_MAX : this.entries.length, 8);
    end.writeUInt16LE(requiresZip64 ? UINT16_MAX : this.entries.length, 10);
    end.writeUInt32LE(requiresZip64 ? UINT32_MAX : Number(centralSize), 12);
    end.writeUInt32LE(requiresZip64 ? UINT32_MAX : Number(centralOffset), 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
  }
}

export type ZipReadEntry = {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  localHeaderOffset: bigint;
  dataOffset: bigint;
};

function readZip64Values(extra: Buffer) {
  const values: bigint[] = [];
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    const start = offset + 4;
    const end = start + length;
    if (end > extra.length) throw new Error("Malformed ZIP extra field");
    if (id === ZIP64_EXTRA_FIELD) {
      for (let cursor = start; cursor + 8 <= end; cursor += 8) values.push(extra.readBigUInt64LE(cursor));
      return values;
    }
    offset = end;
  }
  return values;
}

async function readAt(file: Awaited<ReturnType<typeof open>>, length: number, position: bigint) {
  const buffer = Buffer.alloc(length);
  const result = await file.read(buffer, 0, length, toSafeNumber(position, "ZIP offset"));
  if (result.bytesRead !== length) throw new Error("Unexpected end of ZIP file");
  return buffer;
}

export async function readZipDirectory(filePath: string) {
  const info = await stat(filePath);
  const fileSize = BigInt(info.size);
  if (fileSize < 22n) throw new Error("The uploaded file is not a valid ZIP archive");

  const file = await open(filePath, "r");
  try {
    const tailLength = Math.min(info.size, MAX_EOCD_SEARCH);
    const tail = await readAt(file, tailLength, fileSize - BigInt(tailLength));
    let eocdIndex = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
        const commentLength = tail.readUInt16LE(index + 20);
        if (index + 22 + commentLength === tail.length) {
          eocdIndex = index;
          break;
        }
      }
    }
    if (eocdIndex < 0) throw new Error("ZIP end record was not found");

    const diskNumber = tail.readUInt16LE(eocdIndex + 4);
    const centralDiskNumber = tail.readUInt16LE(eocdIndex + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdIndex + 8);
    const entriesTotal = tail.readUInt16LE(eocdIndex + 10);
    if (diskNumber !== 0 || centralDiskNumber !== 0) throw new Error("Multi-disk ZIP archives are not supported");
    if (entriesOnDisk !== entriesTotal) throw new Error("Multi-disk ZIP archives are not supported");

    let entryCount = BigInt(entriesTotal);
    let centralSize = BigInt(tail.readUInt32LE(eocdIndex + 12));
    let centralOffset = BigInt(tail.readUInt32LE(eocdIndex + 16));
    const usesZip64 =
      entryCount === BigInt(UINT16_MAX) ||
      centralSize === BigInt(UINT32_MAX) ||
      centralOffset === BigInt(UINT32_MAX);

    if (usesZip64) {
      const absoluteEocd = fileSize - BigInt(tail.length) + BigInt(eocdIndex);
      if (absoluteEocd < 20n) throw new Error("ZIP64 locator is missing");
      const locator = await readAt(file, 20, absoluteEocd - 20n);
      if (locator.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
        throw new Error("ZIP64 locator is invalid");
      }
      if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
        throw new Error("Multi-disk ZIP64 archives are not supported");
      }
      const zip64Offset = locator.readBigUInt64LE(8);
      const zip64 = await readAt(file, 56, zip64Offset);
      if (zip64.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
        throw new Error("ZIP64 end record is invalid");
      }
      entryCount = zip64.readBigUInt64LE(32);
      centralSize = zip64.readBigUInt64LE(40);
      centralOffset = zip64.readBigUInt64LE(48);
    }

    if (centralOffset + centralSize > fileSize) throw new Error("ZIP central directory is outside the file");
    if (centralSize > 256n * 1024n * 1024n) throw new Error("ZIP central directory is too large");
    if (entryCount > 1_000_000n) throw new Error("ZIP contains too many entries");

    const central = await readAt(file, toSafeNumber(centralSize, "ZIP central directory"), centralOffset);
    const entries: ZipReadEntry[] = [];
    let cursor = 0;
    while (cursor < central.length) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) {
        throw new Error("ZIP central directory is malformed");
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const entryCrc32 = central.readUInt32LE(cursor + 16);
      const compressed32 = central.readUInt32LE(cursor + 20);
      const uncompressed32 = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const diskStart = central.readUInt16LE(cursor + 34);
      const offset32 = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw new Error("ZIP central directory entry is truncated");

      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const zip64Values = readZip64Values(extra);
      let zip64Index = 0;
      const uncompressedSize = uncompressed32 === UINT32_MAX ? zip64Values[zip64Index++] : BigInt(uncompressed32);
      const compressedSize = compressed32 === UINT32_MAX ? zip64Values[zip64Index++] : BigInt(compressed32);
      const localHeaderOffset = offset32 === UINT32_MAX ? zip64Values[zip64Index++] : BigInt(offset32);
      if (uncompressedSize === undefined || compressedSize === undefined || localHeaderOffset === undefined) {
        throw new Error("ZIP64 entry is missing required sizes");
      }
      if (diskStart !== 0) throw new Error("Multi-disk ZIP entries are not supported");
      if (flags !== UTF8_FLAG) throw new Error("Only BrainVault UTF-8 ZIP entries are supported");
      if (method !== STORE_METHOD) throw new Error("Only BrainVault store-mode ZIP entries are supported");
      if (compressedSize !== uncompressedSize) throw new Error("Stored ZIP entry size mismatch");
      const name = nameBuffer.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(nameBuffer)) throw new Error("ZIP entry name is not valid UTF-8");

      const local = await readAt(file, 30, localHeaderOffset);
      if (local.readUInt32LE(0) !== LOCAL_FILE_HEADER) throw new Error("ZIP local header is invalid");
      if (local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) {
        throw new Error("ZIP local and central headers do not match");
      }
      if (local.readUInt32LE(14) !== entryCrc32) throw new Error("ZIP local checksum does not match its directory");
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const localName = await readAt(file, localNameLength, localHeaderOffset + 30n);
      if (!localName.equals(nameBuffer)) throw new Error("ZIP local entry name does not match its directory");
      const dataOffset = localHeaderOffset + 30n + BigInt(localNameLength + localExtraLength);
      if (dataOffset + compressedSize > fileSize) throw new Error("ZIP entry data is outside the file");

      entries.push({
        name,
        flags,
        method,
        crc32: entryCrc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        dataOffset
      });
      cursor = end;
    }

    if (BigInt(entries.length) !== entryCount) throw new Error("ZIP entry count does not match its directory");
    return entries;
  } finally {
    await file.close();
  }
}

export async function readZipEntryBuffer(filePath: string, entry: ZipReadEntry, maxBytes: number) {
  if (entry.uncompressedSize > BigInt(maxBytes)) throw new Error("ZIP entry exceeds the allowed size");
  if (entry.uncompressedSize === 0n) return Buffer.alloc(0);
  const file = await open(filePath, "r");
  try {
    const data = await readAt(file, toSafeNumber(entry.uncompressedSize, "ZIP entry"), entry.dataOffset);
    if (crc32(data) !== entry.crc32) throw new Error(`ZIP entry checksum failed: ${entry.name}`);
    return data;
  } finally {
    await file.close();
  }
}

export async function copyZipEntryToFile(filePath: string, entry: ZipReadEntry, outputPath: string) {
  const start = toSafeNumber(entry.dataOffset, "ZIP entry offset");
  const size = toSafeNumber(entry.uncompressedSize, "ZIP entry size");
  const end = size === 0 ? start - 1 : start + size - 1;
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  let checksum = 0;
  let written = 0;

  try {
    if (size > 0) {
      for await (const chunk of createReadStream(filePath, { start, end })) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        checksum = updateCrc32(checksum, data);
        written += data.length;
        if (!output.write(data)) await once(output, "drain");
      }
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    throw error;
  }

  if (written !== size || checksum !== entry.crc32) {
    throw new Error(`ZIP entry checksum failed: ${entry.name}`);
  }
}

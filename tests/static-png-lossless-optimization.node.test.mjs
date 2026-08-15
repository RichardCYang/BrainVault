import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import test from "node:test";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const assets = [
  {
    path: "public/img/icon_origin.png",
    width: 1254,
    height: 1254,
    colorType: 6,
    originalBytes: 1_959_371,
    rgbaSha256: "b89443b655b50a2560dd077d481b4ed5e49f3cd528334850f8b5562af316d996"
  },
  {
    path: "public/img/icon_normal.png",
    width: 256,
    height: 256,
    colorType: 6,
    originalBytes: 56_015,
    rgbaSha256: "fea8caf0bd1281f8bb7f59a9394f27518892806dcbb6beaeb93b48111c2fc3e3"
  },
  {
    path: "public/img/default_cover/coverimg2.png",
    width: 1672,
    height: 941,
    colorType: 2,
    originalBytes: 2_059_661,
    rgbaSha256: "0e95066f3ea2a860f8b6d113496ecdbeca917e690c500604d6c7b2252aa09724"
  },
  {
    path: "public/img/default_cover/coverimg4.png",
    width: 1672,
    height: 941,
    colorType: 2,
    originalBytes: 2_404_820,
    rgbaSha256: "c60b830a53916cb806e61a0e7a9d3b8ee63fdf691f8c335282a20fa2d34d4b57"
  },
  {
    path: "public/img/default_cover/coverimg5.png",
    width: 1086,
    height: 1448,
    colorType: 2,
    originalBytes: 2_401_103,
    rgbaSha256: "fe5f137b11f542b9b392567f36e207d371929603216a9d1cdaab23ce1be92c5b"
  }
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(buffer) {
  assert.ok(buffer.subarray(0, pngSignature.length).equals(pngSignature), "invalid PNG signature");
  const chunks = [];
  let offset = pngSignature.length;
  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, "truncated PNG chunk header");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buffer.length, "truncated PNG chunk payload");
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    assert.equal(crc32(Buffer.concat([type, data])), expectedCrc, `invalid ${type.toString("ascii")} CRC`);
    chunks.push({ type: type.toString("ascii"), data });
    offset = dataEnd + 4;
  }
  assert.equal(offset, buffer.length, "unexpected trailing PNG bytes");
  return chunks;
}

function paethPredictor(left, up, upLeft) {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function decodeRgba(chunks) {
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  assert.ok(ihdr, "missing IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compressionMethod = ihdr[10];
  const filterMethod = ihdr[11];
  const interlaceMethod = ihdr[12];
  assert.equal(bitDepth, 8, "optimized assets must remain 8-bit PNGs");
  assert.ok(colorType === 2 || colorType === 6, "optimized assets must remain RGB/RGBA PNGs");
  assert.equal(compressionMethod, 0);
  assert.equal(filterMethod, 0);
  assert.equal(interlaceMethod, 0, "optimized assets must remain non-interlaced");

  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const filtered = inflateSync(compressed);
  assert.equal(filtered.length, height * (rowBytes + 1), "unexpected inflated image length");

  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let rgbaOffset = 0;
  let previous = Buffer.alloc(rowBytes);
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const filterType = filtered[sourceOffset];
    sourceOffset += 1;
    const encoded = filtered.subarray(sourceOffset, sourceOffset + rowBytes);
    sourceOffset += rowBytes;
    const decoded = Buffer.allocUnsafe(rowBytes);

    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= channels ? decoded[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = up;
      else if (filterType === 3) predictor = Math.floor((left + up) / 2);
      else if (filterType === 4) predictor = paethPredictor(left, up, upLeft);
      else assert.equal(filterType, 0, `unsupported PNG filter ${filterType}`);
      decoded[index] = (encoded[index] + predictor) & 0xff;
    }

    if (colorType === 6) {
      decoded.copy(rgba, rgbaOffset);
      rgbaOffset += decoded.length;
    } else {
      for (let index = 0; index < decoded.length; index += 3) {
        rgba[rgbaOffset] = decoded[index];
        rgba[rgbaOffset + 1] = decoded[index + 1];
        rgba[rgbaOffset + 2] = decoded[index + 2];
        rgba[rgbaOffset + 3] = 0xff;
        rgbaOffset += 4;
      }
    }
    previous = decoded;
  }

  return { width, height, colorType, rgba };
}

for (const asset of assets) {
  test(`${asset.path} stays pixel-identical after lossless recompression`, async () => {
    const buffer = await readFile(asset.path);
    const chunks = parsePng(buffer);
    assert.deepEqual(
      [...new Set(chunks.map((chunk) => chunk.type))],
      ["IHDR", "IDAT", "IEND"],
      "recompression must not add or remove image metadata chunks"
    );

    const decoded = decodeRgba(chunks);
    assert.equal(decoded.width, asset.width);
    assert.equal(decoded.height, asset.height);
    assert.equal(decoded.colorType, asset.colorType);
    assert.equal(createHash("sha256").update(decoded.rgba).digest("hex"), asset.rgbaSha256);

    const fileStat = await stat(asset.path);
    assert.ok(fileStat.size < asset.originalBytes, `${asset.path} must remain smaller than its original file`);
  });
}

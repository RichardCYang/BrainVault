import { ApiError } from "./http.js";

export const maxImageDimension = 8_192;
export const maxImagePixels = 16_000_000;
export const maxImageFrames = 100;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
type Dimensions = { width: number; height: number };

function invalid(): never {
  throw new ApiError(400, "IMAGE_DIMENSIONS_NOT_ALLOWED", "Image dimensions or frame count exceed the safe decoding limit, or the image header is invalid");
}

function bounded(width: number, height: number, frames = 1): Dimensions {
  if (width < 1 || height < 1 || width > maxImageDimension || height > maxImageDimension
    || frames < 1 || frames > maxImageFrames || width * height * frames > maxImagePixels) invalid();
  return { width, height };
}

// Inspect container metadata only. Never decompress attacker-controlled pixels
// on the server. Check every animation frame and embedded ICO image as well as
// the outer dimensions, so a small outer canvas cannot conceal a large image.
function pngDimensions(bytes: Buffer, allowAnimation = true): Dimensions {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") invalid();
  const size = bounded(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  let offset = 8;
  let frames = 0;
  let declaredFrames = 0;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalid();
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const data = offset + 8;
    if (type === "IHDR" && offset !== 8) invalid();
    if (type === "acTL") {
      if (!allowAnimation || length !== 8 || declaredFrames || hasData) invalid();
      declaredFrames = bytes.readUInt32BE(data);
      bounded(size.width, size.height, declaredFrames);
    }
    if (type === "fcTL") {
      if (length !== 26 || !declaredFrames || ++frames > declaredFrames) invalid();
      const frame = bounded(bytes.readUInt32BE(data + 4), bytes.readUInt32BE(data + 8));
      if (frame.width + bytes.readUInt32BE(data + 12) > size.width
        || frame.height + bytes.readUInt32BE(data + 16) > size.height) invalid();
    }
    if (type === "IDAT") hasData = true;
    if (type === "IEND") {
      if (length !== 0 || !hasData || frames !== declaredFrames) invalid();
      return size;
    }
    offset += length + 12;
  }
  return invalid();
}

function jpegDimensions(bytes: Buffer): Dimensions {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid();
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || marker === 0x00) invalid();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || bytes[offset + 7] < 1 || length !== 8 + 3 * bytes[offset + 7]) invalid();
      return bounded(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return invalid();
}

function webpBitstreamDimensions(type: string, bytes: Buffer): Dimensions {
  if (type === "VP8 ") {
    if (bytes.length < 10 || (bytes[0] & 1) !== 0 || !bytes.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalid();
    return bounded(bytes.readUInt16LE(6) & 0x3fff, bytes.readUInt16LE(8) & 0x3fff);
  }
  if (type === "VP8L") {
    if (bytes.length < 5 || bytes[0] !== 0x2f || bytes[4] >> 5 !== 0) invalid();
    const packed = bytes.readUInt32LE(1);
    return bounded(1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff));
  }
  return invalid();
}

function webpChunks(bytes: Buffer, visit: (type: string, data: Buffer) => void) {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end + (length & 1) > bytes.length) invalid();
    visit(bytes.toString("latin1", offset, offset + 4), bytes.subarray(offset + 8, end));
    offset = end + (length & 1);
  }
  if (offset !== bytes.length) invalid();
}

function sameDimensions(left: Dimensions, right: Dimensions) {
  if (left.width !== right.width || left.height !== right.height) invalid();
}

function webpDimensions(bytes: Buffer): Dimensions {
  if (bytes.length < 20 || bytes.toString("latin1", 0, 4) !== "RIFF"
    || bytes.toString("latin1", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) invalid();
  let canvas: Dimensions | undefined;
  let image: Dimensions | undefined;
  let extended = false;
  let animated = false;
  let hasAnimationHeader = false;
  let frames = 0;
  webpChunks(bytes.subarray(12), (type, data) => {
    if (type === "VP8X") {
      if (extended || image || frames || data.length !== 10) invalid();
      extended = true;
      animated = Boolean(data[0] & 0x02);
      canvas = bounded(1 + data.readUIntLE(4, 3), 1 + data.readUIntLE(7, 3));
    } else if (type === "VP8 " || type === "VP8L") {
      if (image || animated) invalid();
      image = webpBitstreamDimensions(type, data);
      if (canvas) sameDimensions(canvas, image);
    } else if (type === "ANIM") {
      if (!animated || hasAnimationHeader || data.length !== 6 || frames) invalid();
      hasAnimationHeader = true;
    } else if (type === "ANMF") {
      if (!animated || !hasAnimationHeader || !canvas || data.length < 16) invalid();
      bounded(canvas.width, canvas.height, ++frames);
      const frame = bounded(1 + data.readUIntLE(6, 3), 1 + data.readUIntLE(9, 3));
      if (2 * data.readUIntLE(0, 3) + frame.width > canvas.width
        || 2 * data.readUIntLE(3, 3) + frame.height > canvas.height) invalid();
      let images = 0;
      webpChunks(data.subarray(16), (frameType, frameData) => {
        if (frameType === "VP8 " || frameType === "VP8L") {
          if (++images !== 1) invalid();
          sameDimensions(frame, webpBitstreamDimensions(frameType, frameData));
        }
      });
      if (images !== 1) invalid();
    }
  });
  if (animated ? frames === 0 : !image) invalid();
  return canvas ?? image ?? invalid();
}

function icoDimensions(bytes: Buffer): Dimensions {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) invalid();
  const count = bytes.readUInt16LE(4);
  const directoryEnd = 6 + 16 * count;
  if (!count || count > 256 || directoryEnd > bytes.length) invalid();
  let pixels = 0;
  let largest = { width: 0, height: 0 };
  for (let index = 0; index < count; index++) {
    const offset = 6 + 16 * index;
    const length = bytes.readUInt32LE(offset + 8);
    const start = bytes.readUInt32LE(offset + 12);
    if (!length || start < directoryEnd || start > bytes.length || length > bytes.length - start) invalid();
    const data = bytes.subarray(start, start + length);
    let size: Dimensions;
    if (data.subarray(0, 8).equals(pngSignature)) {
      size = pngDimensions(data, false);
    } else {
      if (data.length < 12) invalid();
      const header = data.readUInt32LE(0);
      if (header === 12) {
        size = bounded(data.readUInt16LE(4), data.readUInt16LE(6) / 2);
      } else {
        if (![40, 52, 56, 108, 124].includes(header) || data.length < header) invalid();
        // Only raw DIB/bitfields are allowed; compressed embedded images would
        // need their own independent dimensions and decoding budget.
        if (![0, 3, 6].includes(data.readUInt32LE(16))) invalid();
        size = bounded(data.readInt32LE(4), Math.abs(data.readInt32LE(8)) / 2);
      }
      if (!Number.isInteger(size.height)) invalid();
    }
    sameDimensions(size, { width: bytes[offset] || 256, height: bytes[offset + 1] || 256 });
    pixels += size.width * size.height;
    if (pixels > maxImagePixels) invalid();
    if (size.width * size.height > largest.width * largest.height) largest = size;
  }
  return largest;
}

export function assertImageDimensionsWithinLimit(mimeType: string, bytes: Buffer): void {
  if (mimeType === "image/png") pngDimensions(bytes);
  else if (mimeType === "image/jpeg") jpegDimensions(bytes);
  else if (mimeType === "image/webp") webpDimensions(bytes);
  else if (mimeType === "image/vnd.microsoft.icon") icoDimensions(bytes);
  else invalid();
}

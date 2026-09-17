// V1 delete sets follow the struct section. Walk their varints without creating
// DeleteItem objects or arrays sized by untrusted counts. The cursor is the
// public restDecoder left by Yjs's lazy metadata reader.
export type YjsDeleteSetCursor = { arr: Uint8Array; pos: number };
export const maxYjsDeleteSetClients = 100_000;
export const maxYjsDeleteSetRanges = 100_000;

function readBoundedVarUint(cursor: YjsDeleteSetCursor, maximum: number, field: string) {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 8; index += 1) {
    if (!Number.isSafeInteger(cursor.pos) || cursor.pos < 0 || cursor.pos >= cursor.arr.byteLength) {
      throw new RangeError("The collaboration delete set is truncated");
    }
    const byte = cursor.arr[cursor.pos++];
    const digit = byte & 0x7f;
    if (digit > Math.floor((maximum - value) / multiplier)) {
      throw new RangeError(`The collaboration delete set ${field} exceeds its structural limit`);
    }
    value += digit * multiplier;
    if ((byte & 0x80) === 0) return value;
    multiplier *= 128;
  }
  throw new RangeError("The collaboration delete set contains a malformed integer");
}

export function assertYjsDeleteSetBudget(cursor: YjsDeleteSetCursor) {
  const clients = readBoundedVarUint(cursor, maxYjsDeleteSetClients, "client count");
  let ranges = 0;
  for (let index = 0; index < clients; index += 1) {
    readBoundedVarUint(cursor, Number.MAX_SAFE_INTEGER, "client id");
    // Check the declared count BEFORE walking any of this client's ranges.
    const clientRanges = readBoundedVarUint(cursor, maxYjsDeleteSetRanges - ranges, "range count");
    ranges += clientRanges;
    for (let range = 0; range < clientRanges; range += 1) {
      const clock = readBoundedVarUint(cursor, Number.MAX_SAFE_INTEGER, "clock");
      const length = readBoundedVarUint(cursor, Number.MAX_SAFE_INTEGER - clock, "range end");
      if (length === 0) throw new RangeError("The collaboration delete set contains an empty range");
    }
  }
  if (cursor.pos !== cursor.arr.byteLength) {
    throw new RangeError("The collaboration update contains trailing bytes");
  }
  return ranges;
}

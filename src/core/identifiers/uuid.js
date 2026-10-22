import { parse, stringify, v7 } from "uuid";

export function createId() {
  return v7();
}

export function uuidToBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  return Buffer.from(parse(value));
}

export function bufferToUuid(value) {
  if (!value) {
    return null;
  }

  return stringify(Uint8Array.from(value));
}

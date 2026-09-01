import { assert } from "./assert.js";
import type { Sha256Hex } from "./types.js";

const SHA_256_HEX_LENGTH = 64;

export function asSha256Hex(value: string): Sha256Hex {
  assert(/^[a-f0-9]{64}$/u.test(value), "sha256 hash must be 64 lowercase hex characters");
  return value as Sha256Hex;
}

export function isSha256Hex(value: string): value is Sha256Hex {
  return value.length === SHA_256_HEX_LENGTH && /^[a-f0-9]+$/u.test(value);
}

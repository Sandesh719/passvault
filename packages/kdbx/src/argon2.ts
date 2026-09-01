import { kdbxweb } from "./kdbxweb.js";
import { argon2d, argon2i, argon2id } from "hash-wasm";

let registered = false;

export type Argon2Impl = Parameters<typeof kdbxweb.CryptoEngine.setArgon2Impl>[0];

/**
 * The Argon2 implementation itself, exported separately from registration so it
 * can be wrapped or counted without going through `CryptoEngine.argon2` — that
 * property is the dispatcher, and calling it from inside a replacement impl
 * recurses forever.
 */
export const argon2Impl: Argon2Impl = async (
  password,
  salt,
  memory,
  iterations,
  length,
  parallelism,
  type
) => {
  const options = {
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    parallelism,
    iterations,
    // kdbxweb reports memory in KiB, which is also what hash-wasm expects.
    memorySize: memory,
    hashLength: length,
    outputType: "binary" as const
  };
  const hash =
    type === kdbxweb.CryptoEngine.Argon2TypeArgon2d
      ? await argon2d(options)
      : type === kdbxweb.CryptoEngine.Argon2TypeArgon2id
        ? await argon2id(options)
        : await argon2i(options);
  const copy = new Uint8Array(hash);
  return copy.buffer;
};

/**
 * Teach kdbxweb how to run Argon2, which KDBX4 requires as its KDF.
 *
 * hash-wasm rather than a native binding: the same WebAssembly module runs on
 * Node, in Electron, and in an Android WebView, so desktop and mobile derive
 * keys through identical code and there is no node-gyp build step per platform.
 *
 * Idempotent — safe to call before every operation.
 */
export function registerArgon2(): void {
  if (registered) {
    return;
  }
  kdbxweb.CryptoEngine.setArgon2Impl(argon2Impl);
  registered = true;
}

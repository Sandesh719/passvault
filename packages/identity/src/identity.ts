import { assert, brand, type DeviceId } from "@passvault/core";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

/**
 * A device's durable cryptographic identity.
 *
 * Ed25519 via @noble/curves rather than WebCrypto or a native binding: the same
 * pure-JavaScript implementation runs on Node, in Electron, and in an Android
 * WebView. WebCrypto only gained Ed25519 in recent Chrome, which would have
 * meant a platform branch in the one place a branch is least welcome.
 */
export interface DeviceKeyPair {
  readonly deviceId: DeviceId;
  readonly publicKey: Uint8Array;
  /** Never leaves this device, never crosses a wire, never enters the metadata store. */
  readonly privateKey: Uint8Array;
}

export interface PublicIdentity {
  readonly deviceId: DeviceId;
  readonly publicKey: Uint8Array;
  readonly name: string;
}

export type DeviceTrust = "paired" | "revoked";

export interface PairedDevice {
  readonly deviceId: DeviceId;
  readonly publicKey: Uint8Array;
  readonly name: string;
  readonly trust: DeviceTrust;
  readonly pairedAt: Date;
  readonly lastSeenAt?: Date;
}

/**
 * The device id is the hash of the public key, so it cannot be claimed by a
 * device that does not hold the matching private key. An id and a key can never
 * disagree, which removes a whole class of impersonation.
 */
export function deviceIdFor(publicKey: Uint8Array): DeviceId {
  return brand<string, "DeviceId">(toHex(sha256(publicKey)));
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { deviceId: deviceIdFor(publicKey), publicKey, privateKey };
}

export function keyPairFromPrivateKey(privateKey: Uint8Array): DeviceKeyPair {
  assert(privateKey.length === 32, "an ed25519 private key is 32 bytes");
  const publicKey = ed25519.getPublicKey(privateKey);
  return { deviceId: deviceIdFor(publicKey), publicKey, privateKey };
}

export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // A malformed signature from a peer is a failed check, not a crash.
    return false;
  }
}

/**
 * What a peer must prove to be let in.
 *
 * Signing the *challenger's* nonce is what makes this a proof of liveness
 * rather than a replayable token: a recording of an earlier session cannot
 * satisfy a nonce it has never seen.
 */
export function authChallengeBytes(input: {
  readonly nonce: Uint8Array;
  readonly challengerDeviceId: DeviceId;
  readonly responderDeviceId: DeviceId;
}): Uint8Array {
  return utf8(
    `passvault/auth/v1\n${input.challengerDeviceId}\n${input.responderDeviceId}\n${toHex(input.nonce)}`
  );
}

export function randomNonce(byteLength = 32): Uint8Array {
  const nonce = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * A six-digit code both devices display after connecting.
 *
 * WebRTC encrypts the transport but proves nothing about who is on the other
 * end — anyone who learns the room details can join as a peer. A signaling
 * server could substitute its own keys and sit in the middle.
 *
 * It cannot make both sides compute the same code while doing so: each side
 * hashes the pair of keys it actually sees, so a substitution yields two
 * different numbers and the humans comparing them notice. Sorting the keys
 * makes the result independent of which side computes it.
 */
export function shortAuthenticationString(a: Uint8Array, b: Uint8Array): string {
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const digest = sha256(concat(utf8("passvault/sas/v1"), first, second));
  // Six digits from the leading bytes: enough that guessing is impractical for
  // an attacker who gets one shot at a live comparison, short enough to read aloud.
  const value =
    ((digest[0] ?? 0) << 16) | ((digest[1] ?? 0) << 8) | (digest[2] ?? 0);
  return String(value % 1_000_000).padStart(6, "0");
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(value: string): Uint8Array {
  assert(/^[a-f0-9]*$/iu.test(value) && value.length % 2 === 0, "expected an even-length hex string");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return a.length - b.length;
}

import { assert, type DeviceId } from "@passvault/core";
import { deviceIdFor, fromBase64, toBase64, type PairedDevice, type PublicIdentity } from "./identity.js";

export const PAIRING_SCHEME = "passvault";
export const PAIRING_VERSION = 1;

/**
 * Everything the other device needs to find us and recognise us.
 *
 * Carried by QR code in practice, so it stays small and URL-safe. Note what is
 * *not* secret here: the public key is public, and the room details only grant
 * the ability to attempt a connection. Possession of this payload is not
 * authority — the short authentication string is what actually gates trust.
 */
export interface PairingOffer {
  readonly version: number;
  readonly deviceId: DeviceId;
  readonly publicKey: Uint8Array;
  readonly name: string;
  readonly roomId: string;
  readonly inviteToken: string;
  readonly signalUrl: string;
}

export function encodePairingOffer(offer: Omit<PairingOffer, "version">): string {
  const params = new URLSearchParams({
    v: String(PAIRING_VERSION),
    k: toBase64(offer.publicKey),
    n: offer.name,
    r: offer.roomId,
    t: offer.inviteToken,
    s: offer.signalUrl
  });
  // The device id is derivable from the key, so it is not transmitted; sending
  // both would allow a payload whose id and key disagree.
  return `${PAIRING_SCHEME}://pair?${params.toString()}`;
}

export type PairingParse =
  | { readonly ok: true; readonly offer: PairingOffer }
  | { readonly ok: false; readonly reason: string };

export function decodePairingOffer(raw: string): PairingParse {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That does not look like a pairing code." };
  }
  if (url.protocol !== `${PAIRING_SCHEME}:`) {
    return { ok: false, reason: "That pairing code is for a different application." };
  }

  const params = url.searchParams;
  const version = Number.parseInt(params.get("v") ?? "", 10);
  if (version !== PAIRING_VERSION) {
    return { ok: false, reason: `Unsupported pairing code version ${params.get("v") ?? "?"}.` };
  }

  const encodedKey = params.get("k");
  const name = params.get("n");
  const roomId = params.get("r");
  const inviteToken = params.get("t");
  const signalUrl = params.get("s");
  if (
    encodedKey === null ||
    name === null ||
    roomId === null ||
    inviteToken === null ||
    signalUrl === null
  ) {
    return { ok: false, reason: "That pairing code is incomplete." };
  }

  let publicKey: Uint8Array;
  try {
    publicKey = fromBase64(encodedKey);
  } catch {
    return { ok: false, reason: "That pairing code has an unreadable key." };
  }
  if (publicKey.byteLength !== 32) {
    return { ok: false, reason: "That pairing code has an invalid key." };
  }

  return {
    ok: true,
    offer: {
      version,
      deviceId: deviceIdFor(publicKey),
      publicKey,
      name,
      roomId,
      inviteToken,
      signalUrl
    }
  };
}

/**
 * Durable record of which devices this one has agreed to sync with.
 *
 * Pinning the public key is the whole point: after pairing, a peer claiming a
 * known device id must prove possession of the key that was pinned then.
 */
export interface TrustStore {
  pair(device: Omit<PairedDevice, "trust" | "pairedAt"> & { readonly pairedAt: Date }): Promise<void>;
  get(deviceId: DeviceId): Promise<PairedDevice | undefined>;
  list(): Promise<readonly PairedDevice[]>;
  revoke(deviceId: DeviceId): Promise<void>;
  markSeen(deviceId: DeviceId, at: Date): Promise<void>;
}

export type TrustDecision =
  | { readonly kind: "trusted"; readonly device: PairedDevice }
  | { readonly kind: "unknown-device" }
  | { readonly kind: "revoked" }
  /** Same id, different key. Either an impersonation attempt or a reinstalled device. */
  | { readonly kind: "key-mismatch" };

export async function evaluateTrust(
  store: TrustStore,
  claimed: PublicIdentity
): Promise<TrustDecision> {
  assert(
    deviceIdFor(claimed.publicKey) === claimed.deviceId,
    "device id must be the hash of the presented public key"
  );

  const known = await store.get(claimed.deviceId);
  if (known === undefined) {
    return { kind: "unknown-device" };
  }
  if (known.trust === "revoked") {
    return { kind: "revoked" };
  }
  if (!equalBytes(known.publicKey, claimed.publicKey)) {
    return { kind: "key-mismatch" };
  }
  return { kind: "trusted", device: known };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

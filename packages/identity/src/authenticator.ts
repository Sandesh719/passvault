import type { AuthOutcome, DeviceId, PeerAuthenticator } from "@passvault/core";
import {
  authChallengeBytes,
  deviceIdFor,
  randomNonce,
  sign,
  verify,
  type DeviceKeyPair
} from "./identity.js";
import { evaluateTrust, type TrustStore } from "./pairing.js";

export interface AuthenticatorOptions {
  readonly keyPair: DeviceKeyPair;
  readonly deviceName: string;
  readonly trustStore: TrustStore;
  /**
   * Accept a device we have never paired with, and pin its key on first sight.
   *
   * Only true while the user is actively pairing and about to compare the short
   * authentication string. Leaving it on would reduce trust to "whoever reaches
   * the room first", which is exactly the hole pairing exists to close.
   */
  readonly pairingMode?: boolean;
  /**
   * Ask a human to confirm the short authentication string before a key is
   * pinned.
   *
   * This is the only moment the number means anything. Showing it after pairing
   * has already happened is decoration: by then the key is pinned and refusing
   * costs an undo. Called after the signature has verified — so the user is
   * never asked to judge a peer that cannot even prove possession of its key —
   * and before `trustStore.pair`, so answering "no" leaves no trace behind.
   *
   * Omitted, pairing mode pins on first sight, which is the old behaviour and
   * the right one for tests and headless use.
   */
  readonly confirmPairing?: (peer: {
    readonly deviceId: DeviceId;
    readonly publicKey: Uint8Array;
    readonly name: string;
  }) => Promise<boolean>;
  readonly now?: () => Date;
}

export function createAuthenticator(options: AuthenticatorOptions): PeerAuthenticator {
  const now = options.now ?? ((): Date => new Date());

  return {
    deviceId: options.keyPair.deviceId,
    deviceName: options.deviceName,
    publicKey: options.keyPair.publicKey,

    newNonce: () => randomNonce(),

    signChallenge: async (input) =>
      sign(options.keyPair.privateKey, authChallengeBytes(input)),

    verifyPeer: async (input): Promise<AuthOutcome> => {
      // An id that is not the hash of the presented key is a forged claim, and
      // is rejected before any signature work is done.
      if (deviceIdFor(input.publicKey) !== input.deviceId) {
        return { kind: "reject", reason: "device id does not match the presented public key" };
      }

      const challenge = authChallengeBytes({
        nonce: input.nonce,
        challengerDeviceId: options.keyPair.deviceId,
        responderDeviceId: input.deviceId
      });
      if (!verify(input.publicKey, challenge, input.signature)) {
        return { kind: "reject", reason: "signature did not verify against the presented key" };
      }

      const decision = await evaluateTrust(options.trustStore, {
        deviceId: input.deviceId,
        publicKey: input.publicKey,
        name: input.claimedName
      });

      switch (decision.kind) {
        case "trusted":
          await options.trustStore.markSeen(input.deviceId, now());
          return { kind: "accept", deviceName: decision.device.name };
        case "unknown-device":
          if (options.pairingMode !== true) {
            return { kind: "reject", reason: "device is not paired with this one" };
          }
          if (
            options.confirmPairing !== undefined &&
            !(await options.confirmPairing({
              deviceId: input.deviceId,
              publicKey: input.publicKey,
              name: input.claimedName
            }))
          ) {
            return {
              kind: "reject",
              reason: "the pairing numbers were not confirmed on this device"
            };
          }
          await options.trustStore.pair({
            deviceId: input.deviceId,
            publicKey: input.publicKey,
            name: input.claimedName,
            pairedAt: now()
          });
          return { kind: "accept", deviceName: input.claimedName };
        case "revoked":
          return { kind: "reject", reason: "device has been revoked" };
        case "key-mismatch":
          // Either an impersonation attempt or a genuine reinstall. Both need a
          // human to re-pair deliberately, so neither is resolved silently here.
          return {
            kind: "reject",
            reason: "device key has changed since pairing; pair again to accept the new key"
          };
        default:
          return { kind: "reject", reason: "unrecognised trust decision" };
      }
    }
  };
}

export function trustStoreFromMap(devices: Map<DeviceId, import("./identity.js").PairedDevice>): TrustStore {
  return {
    pair: async (device) => {
      devices.set(device.deviceId, { ...device, trust: "paired" });
    },
    get: async (deviceId) => devices.get(deviceId),
    list: async () => [...devices.values()],
    revoke: async (deviceId) => {
      const existing = devices.get(deviceId);
      if (existing !== undefined) {
        devices.set(deviceId, { ...existing, trust: "revoked" });
      }
    },
    markSeen: async (deviceId, at) => {
      const existing = devices.get(deviceId);
      if (existing !== undefined) {
        devices.set(deviceId, { ...existing, lastSeenAt: at });
      }
    }
  };
}

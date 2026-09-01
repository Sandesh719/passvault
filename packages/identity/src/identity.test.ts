import { describe, expect, it } from "vitest";
import {
  authChallengeBytes,
  deviceIdFor,
  fromBase64,
  fromHex,
  generateDeviceKeyPair,
  keyPairFromPrivateKey,
  randomNonce,
  shortAuthenticationString,
  sign,
  toBase64,
  toHex,
  verify
} from "./identity.js";
import { createAuthenticator } from "./authenticator.js";
import { decodePairingOffer, encodePairingOffer, evaluateTrust, type TrustStore } from "./pairing.js";
import type { DeviceId } from "@passvault/core";
import type { PairedDevice } from "./identity.js";

function memoryTrustStore(seed: readonly PairedDevice[] = []): TrustStore {
  const devices = new Map<DeviceId, PairedDevice>(seed.map((device) => [device.deviceId, device]));
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

describe("device keys", () => {
  it("derives a stable id from the public key", () => {
    const pair = generateDeviceKeyPair();
    expect(pair.deviceId).toBe(deviceIdFor(pair.publicKey));
    expect(pair.deviceId).toHaveLength(64);
  });

  it("reconstructs the same identity from a stored private key", () => {
    // Restart persistence: the device must keep its identity across launches,
    // unlike the prototype's per-page-load random peer id.
    const original = generateDeviceKeyPair();
    const restored = keyPairFromPrivateKey(original.privateKey);
    expect(restored.deviceId).toBe(original.deviceId);
    expect(restored.publicKey).toEqual(original.publicKey);
  });

  it("signs and verifies", () => {
    const pair = generateDeviceKeyPair();
    const message = new TextEncoder().encode("prove it");
    expect(verify(pair.publicKey, message, sign(pair.privateKey, message))).toBe(true);
  });

  it("rejects a signature from a different key", () => {
    const signer = generateDeviceKeyPair();
    const impostor = generateDeviceKeyPair();
    const message = new TextEncoder().encode("prove it");
    expect(verify(impostor.publicKey, message, sign(signer.privateKey, message))).toBe(false);
  });

  it("rejects a signature over different content", () => {
    const pair = generateDeviceKeyPair();
    const signature = sign(pair.privateKey, new TextEncoder().encode("one thing"));
    expect(verify(pair.publicKey, new TextEncoder().encode("another"), signature)).toBe(false);
  });

  it("treats a malformed signature as a failed check, not an exception", () => {
    const pair = generateDeviceKeyPair();
    expect(verify(pair.publicKey, new Uint8Array([1]), new Uint8Array([9, 9, 9]))).toBe(false);
  });
});

describe("auth challenge", () => {
  it("binds the signature to both devices and the nonce", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    const nonce = randomNonce();

    const challenge = authChallengeBytes({
      nonce,
      challengerDeviceId: a.deviceId,
      responderDeviceId: b.deviceId
    });
    const signature = sign(b.privateKey, challenge);
    expect(verify(b.publicKey, challenge, signature)).toBe(true);

    // A signature captured from an earlier session carries a different nonce,
    // so replaying it against a fresh challenge fails.
    const replayed = authChallengeBytes({
      nonce: randomNonce(),
      challengerDeviceId: a.deviceId,
      responderDeviceId: b.deviceId
    });
    expect(verify(b.publicKey, replayed, signature)).toBe(false);
  });

  it("does not accept a challenge signed for a different pair of devices", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    const c = generateDeviceKeyPair();
    const nonce = randomNonce();

    const forB = authChallengeBytes({
      nonce,
      challengerDeviceId: a.deviceId,
      responderDeviceId: b.deviceId
    });
    const forC = authChallengeBytes({
      nonce,
      challengerDeviceId: a.deviceId,
      responderDeviceId: c.deviceId
    });
    expect(verify(b.publicKey, forC, sign(b.privateKey, forB))).toBe(false);
  });
});

describe("short authentication string", () => {
  it("is six digits and identical on both devices", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();

    const fromA = shortAuthenticationString(a.publicKey, b.publicKey);
    const fromB = shortAuthenticationString(b.publicKey, a.publicKey);

    expect(fromA).toMatch(/^\d{6}$/u);
    expect(fromA).toBe(fromB);
  });

  it("differs when a third key is substituted in the middle", () => {
    // The MITM case. A machine in the middle presents its own key to each side,
    // so the two devices compute different codes and the humans comparing them
    // see a mismatch.
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    const attacker = generateDeviceKeyPair();

    const aSees = shortAuthenticationString(a.publicKey, attacker.publicKey);
    const bSees = shortAuthenticationString(attacker.publicKey, b.publicKey);
    const honest = shortAuthenticationString(a.publicKey, b.publicKey);

    expect(aSees).not.toBe(honest);
    expect(bSees).not.toBe(honest);
    expect(aSees).not.toBe(bSees);
  });
});

describe("pairing offers", () => {
  const pair = generateDeviceKeyPair();
  const offer = {
    deviceId: pair.deviceId,
    publicKey: pair.publicKey,
    name: "Vikas Laptop",
    roomId: "room-123",
    inviteToken: "token-abc",
    signalUrl: "ws://localhost:8787/signal"
  };

  it("round-trips through an encoded code", () => {
    const decoded = decodePairingOffer(encodePairingOffer(offer));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.offer.deviceId).toBe(pair.deviceId);
    expect(decoded.offer.publicKey).toEqual(pair.publicKey);
    expect(decoded.offer.name).toBe("Vikas Laptop");
    expect(decoded.offer.roomId).toBe("room-123");
  });

  it("derives the device id from the key rather than trusting a transmitted one", () => {
    // An offer cannot claim an id that disagrees with its key, because the id
    // is never carried in the payload.
    const encoded = encodePairingOffer(offer);
    expect(encoded).not.toContain(pair.deviceId);
  });

  it("rejects a code from another application", () => {
    expect(decodePairingOffer("https://example.com/pair?v=1")).toMatchObject({ ok: false });
  });

  it("rejects an unsupported version", () => {
    const encoded = encodePairingOffer(offer).replace("v=1", "v=99");
    expect(decodePairingOffer(encoded)).toMatchObject({ ok: false, reason: /version/u });
  });

  it("rejects a key of the wrong length", () => {
    const encoded = encodePairingOffer(offer).replace(
      `k=${encodeURIComponent(toBase64(pair.publicKey))}`,
      `k=${encodeURIComponent(toBase64(new Uint8Array([1, 2, 3])))}`
    );
    expect(decodePairingOffer(encoded)).toMatchObject({ ok: false, reason: /invalid key/u });
  });

  it("rejects nonsense", () => {
    expect(decodePairingOffer("not a url at all")).toMatchObject({ ok: false });
  });
});

describe("trust evaluation", () => {
  const known = generateDeviceKeyPair();

  const paired: PairedDevice = {
    deviceId: known.deviceId,
    publicKey: known.publicKey,
    name: "Desktop",
    trust: "paired",
    pairedAt: new Date("2026-01-01T00:00:00.000Z")
  };

  it("accepts a paired device presenting its pinned key", async () => {
    const decision = await evaluateTrust(memoryTrustStore([paired]), {
      deviceId: known.deviceId,
      publicKey: known.publicKey,
      name: "Desktop"
    });
    expect(decision.kind).toBe("trusted");
  });

  it("does not recognise a device that was never paired", async () => {
    const stranger = generateDeviceKeyPair();
    const decision = await evaluateTrust(memoryTrustStore([paired]), {
      deviceId: stranger.deviceId,
      publicKey: stranger.publicKey,
      name: "Stranger"
    });
    expect(decision.kind).toBe("unknown-device");
  });

  it("refuses a revoked device", async () => {
    const store = memoryTrustStore([paired]);
    await store.revoke(known.deviceId);
    const decision = await evaluateTrust(store, {
      deviceId: known.deviceId,
      publicKey: known.publicKey,
      name: "Desktop"
    });
    expect(decision.kind).toBe("revoked");
  });

  it("refuses an identity whose id does not hash from its key", async () => {
    const stranger = generateDeviceKeyPair();
    await expect(
      evaluateTrust(memoryTrustStore([paired]), {
        deviceId: known.deviceId,
        publicKey: stranger.publicKey,
        name: "Impostor"
      })
    ).rejects.toThrow(/hash of the presented public key/u);
  });
});

describe("encoding helpers", () => {
  it("round-trips hex and base64", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("rejects malformed hex", () => {
    expect(() => fromHex("abc")).toThrow(/even-length hex/u);
  });
});

/**
 * The short authentication string is only worth showing while it can still
 * change the outcome. These pin down that it gates the pinning of a key rather
 * than decorating a decision already made.
 */
describe("confirming a pairing", () => {
  const us = generateDeviceKeyPair();
  const them = generateDeviceKeyPair();

  /** A peer that genuinely holds its key, answering our challenge correctly. */
  function honestPeerProof(): Parameters<
    ReturnType<typeof createAuthenticator>["verifyPeer"]
  >[0] {
    const ourNonce = randomNonce();
    return {
      deviceId: them.deviceId,
      publicKey: them.publicKey,
      nonce: ourNonce,
      signature: sign(
        them.privateKey,
        authChallengeBytes({
          nonce: ourNonce,
          challengerDeviceId: us.deviceId,
          responderDeviceId: them.deviceId
        })
      ),
      claimedName: "Laptop"
    };
  }

  it("pins the key once the numbers are confirmed", async () => {
    const store = memoryTrustStore();
    const outcome = await createAuthenticator({
      keyPair: us,
      deviceName: "Desktop",
      trustStore: store,
      pairingMode: true,
      confirmPairing: async () => true
    }).verifyPeer(honestPeerProof());

    expect(outcome.kind).toBe("accept");
    expect(await store.get(them.deviceId)).toMatchObject({ trust: "paired" });
  });

  it("leaves no trace of a device the user refused", async () => {
    const store = memoryTrustStore();
    const outcome = await createAuthenticator({
      keyPair: us,
      deviceName: "Desktop",
      trustStore: store,
      pairingMode: true,
      confirmPairing: async () => false
    }).verifyPeer(honestPeerProof());

    expect(outcome).toMatchObject({ kind: "reject" });
    // Saying no must cost nothing to undo, which it does not if the key was
    // pinned first and revoked afterwards.
    expect(await store.get(them.deviceId)).toBeUndefined();
  });

  it("does not ask about a peer that cannot prove it holds its key", async () => {
    let asked = false;
    const proof = honestPeerProof();
    const outcome = await createAuthenticator({
      keyPair: us,
      deviceName: "Desktop",
      trustStore: memoryTrustStore(),
      pairingMode: true,
      confirmPairing: async () => {
        asked = true;
        return true;
      }
    }).verifyPeer({ ...proof, signature: sign(us.privateKey, new Uint8Array([1, 2, 3])) });

    expect(outcome).toMatchObject({ kind: "reject" });
    // Asking a person to judge junk teaches them the question is a formality.
    expect(asked).toBe(false);
  });

  it("does not ask again about a device already paired", async () => {
    let asked = false;
    const store = memoryTrustStore([
      {
        deviceId: them.deviceId,
        publicKey: them.publicKey,
        name: "Laptop",
        trust: "paired",
        pairedAt: new Date("2026-01-01T00:00:00.000Z")
      }
    ]);
    const outcome = await createAuthenticator({
      keyPair: us,
      deviceName: "Desktop",
      trustStore: store,
      pairingMode: true,
      confirmPairing: async () => {
        asked = true;
        return true;
      }
    }).verifyPeer(honestPeerProof());

    expect(outcome.kind).toBe("accept");
    expect(asked).toBe(false);
  });
});

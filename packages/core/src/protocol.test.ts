import { describe, expect, it } from "vitest";
import { LIMITS, encodeMessage, parseMessage, PROTOCOL_VERSION } from "./protocol.js";
import { brand } from "./types.js";

const HASH = "a".repeat(64);

function parsed(value: unknown): ReturnType<typeof parseMessage> {
  return parseMessage(JSON.stringify(value));
}

describe("protocol parsing", () => {
  it("round-trips a hello", () => {
    const outcome = parseMessage(
      encodeMessage({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        deviceId: brand<string, "DeviceId">("device-a"),
        deviceName: "Laptop",
        publicKey: "AAAA",
        nonce: "BBBB"
      })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === "hello") {
      expect(outcome.message.deviceName).toBe("Laptop");
      expect(outcome.message.publicKey).toBe("AAAA");
    }
  });

  it("rejects a hello with no key or nonce to authenticate against", () => {
    // Identity is not optional: a peer that omits these cannot be checked, so
    // the message is refused rather than treated as an anonymous connection.
    expect(
      parsed({ type: "hello", protocolVersion: 1, deviceId: "d", deviceName: "n" })
    ).toMatchObject({ ok: false, code: "malformed-message" });
  });

  it("round-trips an auth signature", () => {
    const outcome = parseMessage(encodeMessage({ type: "auth", signature: "c2ln" }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === "auth") {
      expect(outcome.message.signature).toBe("c2ln");
    }
  });

  it("rejects input that is not JSON", () => {
    const outcome = parseMessage("{not json");
    expect(outcome).toMatchObject({ ok: false, code: "malformed-message" });
  });

  it("rejects a message with no type", () => {
    expect(parsed({ deviceId: "x" })).toMatchObject({ ok: false, code: "malformed-message" });
  });

  it("rejects an unknown type instead of ignoring it", () => {
    expect(parsed({ type: "please-exfiltrate" })).toMatchObject({ ok: false, code: "malformed-message" });
  });

  it("rejects a hash that is not a sha256 digest", () => {
    const outcome = parsed({
      type: "history-summary",
      vaultId: "v",
      revisions: [{ revisionId: "r1", hash: "nope", sizeBytes: 1, parentIds: [] }]
    });
    expect(outcome).toMatchObject({ ok: false, code: "malformed-message" });
  });

  it("rejects a history summary larger than the cap", () => {
    // A peer must not be able to make us build an arbitrarily large graph.
    const revisions = Array.from({ length: LIMITS.maxHistoryNodes + 1 }, (_, index) => ({
      revisionId: `r${index}`,
      hash: HASH,
      sizeBytes: 1,
      parentIds: []
    }));
    expect(parsed({ type: "history-summary", vaultId: "v", revisions })).toMatchObject({
      ok: false,
      code: "limit-exceeded"
    });
  });

  it("rejects a revision claiming an absurd number of parents", () => {
    const parentIds = Array.from({ length: LIMITS.maxParentsPerRevision + 1 }, (_, i) => `p${i}`);
    expect(
      parsed({
        type: "history-summary",
        vaultId: "v",
        revisions: [{ revisionId: "r1", hash: HASH, sizeBytes: 1, parentIds }]
      })
    ).toMatchObject({ ok: false, code: "limit-exceeded" });
  });

  it("rejects a revision-header declaring an impossible size", () => {
    expect(
      parsed({
        type: "revision-header",
        transferSeq: 1,
        vaultId: "v",
        revisionId: "r1",
        hash: HASH,
        sizeBytes: LIMITS.maxRevisionBytes + 1,
        parentIds: [],
        totalChunks: 1
      })
    ).toMatchObject({ ok: false, code: "limit-exceeded" });
  });

  it("rejects negative counts", () => {
    expect(
      parsed({ type: "vault-summary", vaultId: "v", headRevisionId: "r", revisionCount: -1 })
    ).toMatchObject({ ok: false, code: "malformed-message" });
  });

  it("rejects an over-long string", () => {
    const huge = "x".repeat(LIMITS.maxStringLength + 1);
    expect(
      parsed({ type: "hello", protocolVersion: 1, deviceId: huge, deviceName: "n", publicKey: "k", nonce: "n" })
    ).toMatchObject({ ok: false, code: "malformed-message" });
  });

  it("accepts a well-formed history summary", () => {
    const outcome = parsed({
      type: "history-summary",
      vaultId: "v",
      revisions: [
        { revisionId: "r1", hash: HASH, sizeBytes: 10, parentIds: [] },
        { revisionId: "r2", hash: HASH, sizeBytes: 12, parentIds: ["r1"] }
      ]
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === "history-summary") {
      expect(outcome.message.revisions).toHaveLength(2);
      expect(outcome.message.revisions[1]?.parentIds).toEqual(["r1"]);
    }
  });

  it("normalizes an unrecognized error code rather than trusting it", () => {
    const outcome = parsed({ type: "error", code: "made-up", message: "hi" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.message.type === "error") {
      expect(outcome.message.code).toBe("internal");
    }
  });
});

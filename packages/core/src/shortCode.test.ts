import { describe, expect, it } from "vitest";
import {
  SHORT_CODE_ALPHABET,
  formatQualifiedShortCode,
  formatShortCode,
  httpUrlFor,
  isLocalHost,
  isValidServerHost,
  looksLikeShortCode,
  normalizeShortCode,
  parseShortCode,
  signalUrlFor
} from "./shortCode.js";

/**
 * A code that only works when typed perfectly is a code that does not work.
 * The point of the restricted alphabet is that the mistakes people make while
 * copying eight characters off a screen are all recoverable.
 */
describe("short pairing codes", () => {
  it("excludes the characters that change identity between screen and keyboard", () => {
    for (const ambiguous of ["I", "L", "O", "U"]) {
      expect(SHORT_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it("reads the code back however it was typed", () => {
    const canonical = "4F7K2QX9";
    for (const typed of ["4F7K-2QX9", "4f7k2qx9", "  4F7K 2QX9 ", "4f7k--2qx9"]) {
      expect(normalizeShortCode(typed)).toBe(canonical);
    }
  });

  it("recovers the substitutions the alphabet was chosen to make safe", () => {
    // Someone reading 0 as O, or 1 as I or l, lands on the same code.
    expect(normalizeShortCode("O123456I")).toBe("01234561");
    expect(normalizeShortCode("l1234567")).toBe("11234567");
  });

  it("groups the code so a person can hold it in their head", () => {
    expect(formatShortCode("4F7K2QX9")).toBe("4F7K-2QX9");
  });

  it("tells a code apart from a pairing link", () => {
    expect(looksLikeShortCode("4F7K-2QX9")).toBe(true);
    expect(looksLikeShortCode("4f7k2qx9")).toBe(true);
    // The full link must never be mistaken for a code, or it gets sent to the
    // server for redemption instead of being decoded locally.
    expect(looksLikeShortCode("passvault://pair?v=1&k=abc")).toBe(false);
    expect(looksLikeShortCode("4F7K")).toBe(false);
    expect(looksLikeShortCode("")).toBe(false);
  });
});

/**
 * A bare code is a receipt with no address on it. Two devices set to different
 * servers can only pair if the code says where it is valid — which is the
 * difference between syncing across a room and syncing across the world.
 */
describe("codes that name their server", () => {
  it("carries the server for a device that is set to another one", () => {
    expect(formatQualifiedShortCode("4F7K2QX9", "sync.example.org")).toBe(
      "4F7K-2QX9@sync.example.org"
    );
  });

  it("reads back the code and where to redeem it", () => {
    expect(parseShortCode("4F7K-2QX9@sync.example.org")).toEqual({
      code: "4F7K2QX9",
      host: "sync.example.org"
    });
    expect(parseShortCode("  4f7k2qx9@Sync.Example.ORG:8787 ")).toEqual({
      code: "4F7K2QX9",
      host: "sync.example.org:8787"
    });
  });

  it("leaves the server out when the code does not name one", () => {
    // Redeemed against whatever this device is set to, which is right when
    // both devices share a server and the whole problem when they do not.
    expect(parseShortCode("4F7K-2QX9")).toEqual({ code: "4F7K2QX9" });
  });

  it("never mistakes a pairing link for a code", () => {
    // A link carries its own server inside it and is decoded locally. Treating
    // one as a code would send it to a server to be redeemed, which fails in a
    // way that looks like the link is broken.
    expect(parseShortCode("passvault://pair?v=1&k=abc&n=a@b")).toBeUndefined();
    expect(looksLikeShortCode("passvault://pair?v=1")).toBe(false);
  });

  it("refuses a host that is not just a host", () => {
    for (const bad of [
      "sync.example.org/path",
      "http://sync.example.org",
      "user:pass@sync.example.org",
      "sync.example.org:99999",
      "sync example org",
      ""
    ]) {
      expect(isValidServerHost(bad)).toBe(false);
      expect(parseShortCode(`4F7K-2QX9@${bad}`)).toBeUndefined();
    }
  });

  it("accepts the hosts people actually run", () => {
    for (const good of ["localhost:8787", "127.0.0.1:8787", "sync.example.org", "my-nas.local"]) {
      expect(isValidServerHost(good)).toBe(true);
    }
  });
});

describe("choosing a scheme for a server", () => {
  it("keeps loopback and LAN names in the clear", () => {
    for (const local of ["localhost:8787", "127.0.0.1", "my-nas.local"]) {
      expect(isLocalHost(local)).toBe(true);
    }
    expect(httpUrlFor("localhost:8787")).toBe("http://localhost:8787");
    expect(signalUrlFor("localhost:8787")).toBe("ws://localhost:8787/signal");
  });

  it("requires TLS for anything on the internet", () => {
    // Without this the pairing offer could be rewritten in flight by anyone on
    // the path, which is a far bigger deal once the server is not on this desk.
    expect(isLocalHost("sync.example.org")).toBe(false);
    expect(httpUrlFor("sync.example.org")).toBe("https://sync.example.org");
    expect(signalUrlFor("sync.example.org")).toBe("wss://sync.example.org/signal");
  });
});

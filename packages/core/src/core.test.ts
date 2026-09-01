import { describe, expect, it } from "vitest";
import {
  asSha256Hex,
  bookmarkRevision,
  brand,
  importedRevision,
  localChangeRevision,
  mergedRevision,
  planChunks,
  promoteRevision,
  receivedRevision,
  type DeviceId,
  type RevisionId,
  type RevisionSeed,
  type Vault,
  type VaultId
} from "./index.js";

const vaultId = brand<string, "VaultId">("vault-1") as VaultId;
const deviceB = brand<string, "DeviceId">("device-b") as DeviceId;

function seed(id: string): RevisionSeed {
  return {
    id: brand<string, "RevisionId">(id),
    vaultId,
    hash: asSha256Hex("a".repeat(64)),
    sizeBytes: 1,
    at: new Date("2026-01-01T00:00:00.000Z")
  };
}

describe("core revision contracts", () => {
  it("promotes a revision by moving only the head pointer", () => {
    const vault: Vault = {
      id: vaultId,
      name: "Main",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    };
    const revision = importedRevision(seed("rev-1"));

    const result = promoteRevision({
      vault,
      nextRevision: revision,
      at: new Date("2026-01-02T00:00:00.000Z")
    });

    expect(result.vault.headRevisionId).toBe(revision.id);
    expect(result.event.previousRevisionId).toBeUndefined();
    expect(result.event.reason).toBe("promote");
  });

  it("requires bookmark messages", () => {
    expect(() =>
      bookmarkRevision({
        bookmarkId: brand<string, "BookmarkId">("bookmark-1"),
        revision: importedRevision(seed("rev-1")),
        message: "",
        at: new Date()
      })
    ).toThrow(/bookmark message/u);
  });
});

describe("revision lineage", () => {
  it("roots an imported revision with no parents", () => {
    expect(importedRevision(seed("rev-1")).parentIds).toEqual([]);
  });

  it("parents a local change on the current head", () => {
    const head = brand<string, "RevisionId">("rev-1") as RevisionId;
    expect(localChangeRevision(seed("rev-2"), head).parentIds).toEqual([head]);
  });

  it("copies a received revision's parents verbatim and ignores local head", () => {
    // The whole point: this constructor cannot see local state, so a revision
    // authored elsewhere can never be re-parented onto our own history.
    const declared = [brand<string, "RevisionId">("their-rev-3") as RevisionId];
    const received = receivedRevision(seed("their-rev-4"), declared, deviceB);

    expect(received.parentIds).toEqual(declared);
    expect(received.originDeviceId).toBe(deviceB);
    expect(received.operation).toBe("received");
  });

  it("refuses a revision that claims itself as a parent", () => {
    const self = brand<string, "RevisionId">("rev-loop") as RevisionId;
    expect(() => receivedRevision(seed("rev-loop"), [self], deviceB)).toThrow(/own parent/u);
  });

  it("records every merge input as a parent", () => {
    const base = brand<string, "RevisionId">("rev-base") as RevisionId;
    const incoming = [
      brand<string, "RevisionId">("rev-x") as RevisionId,
      brand<string, "RevisionId">("rev-y") as RevisionId
    ];
    expect(mergedRevision(seed("rev-merged"), base, incoming).parentIds).toEqual([base, ...incoming]);
  });

  it("refuses a merge with duplicate parents", () => {
    const base = brand<string, "RevisionId">("rev-base") as RevisionId;
    expect(() => mergedRevision(seed("rev-merged"), base, [base])).toThrow(/distinct/u);
  });

  it("refuses a merge with no incoming revisions", () => {
    const base = brand<string, "RevisionId">("rev-base") as RevisionId;
    expect(() => mergedRevision(seed("rev-merged"), base, [])).toThrow(/at least one/u);
  });
});

describe("chunk planning", () => {
  it("plans stable chunks", () => {
    expect(planChunks(10, 4)).toEqual([
      { chunkIndex: 0, offset: 0, length: 4 },
      { chunkIndex: 1, offset: 4, length: 4 },
      { chunkIndex: 2, offset: 8, length: 2 }
    ]);
  });
});

import {
  asSha256Hex,
  brand,
  classifyDivergence,
  importedRevision,
  localChangeRevision,
  receivedRevision,
  type DeviceId,
  type RevisionId,
  type RevisionSeed,
  type Vault,
  type VaultId
} from "@passvault/core";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Sync } from "./blobStore.js";
import { openLocalStore, type LocalStore } from "./store.js";

const vaultId = brand<string, "VaultId">("vault-1") as VaultId;
const deviceB = brand<string, "DeviceId">("device-b") as DeviceId;

let root: string;
let store: LocalStore;

function seed(id: string, bytes: Uint8Array): RevisionSeed {
  return {
    id: brand<string, "RevisionId">(id),
    vaultId,
    hash: sha256Sync(bytes),
    sizeBytes: bytes.byteLength,
    at: new Date("2026-01-01T00:00:00.000Z")
  };
}

const vault: Vault = { id: vaultId, name: "Main", createdAt: new Date("2026-01-01T00:00:00.000Z") };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "passvault-test-"));
  store = await openLocalStore(root);
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("FileBlobStore", () => {
  it("round-trips bytes through a content-addressed key", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = await store.blobs.put(bytes);

    expect(hash).toBe(sha256Sync(bytes));
    expect(await store.blobs.get(hash)).toEqual(bytes);
    expect(await store.blobs.sizeOf(hash)).toBe(5);
    expect(await store.blobs.has(hash)).toBe(true);
  });

  it("stores identical content once", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const first = await store.blobs.put(bytes);
    const second = await store.blobs.put(new Uint8Array([9, 9, 9]));

    expect(second).toBe(first);
    // Two devices holding the same revision must not cost two copies on disk.
    const shard = await readdir(join(root, "blobs", first.slice(0, 2)));
    expect(shard).toHaveLength(1);
  });

  it("leaves no temp files behind after a successful write", async () => {
    await store.blobs.put(new Uint8Array([7]));
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("detects content that no longer matches its key", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const hash = await store.blobs.put(bytes);
    expect(await store.blobs.verify(hash)).toBe(true);

    const missing = asSha256Hex("b".repeat(64));
    expect(await store.blobs.verify(missing)).toBe(false);
  });

  it("reports absence rather than throwing for an unknown key", async () => {
    expect(await store.blobs.has(asSha256Hex("c".repeat(64)))).toBe(false);
    expect(await store.blobs.sizeOf(asSha256Hex("c".repeat(64)))).toBeUndefined();
  });
});

describe("SqliteMetadataStore", () => {
  it("stores and reloads a vault", async () => {
    await store.metadata.saveVault(vault);
    const loaded = await store.metadata.getVault(vaultId);

    expect(loaded?.name).toBe("Main");
    expect(loaded?.headRevisionId).toBeUndefined();
  });

  it("stores a revision with its parent edges", async () => {
    await store.metadata.saveVault(vault);
    const first = importedRevision(seed("r1", new Uint8Array([1])));
    const second = localChangeRevision(seed("r2", new Uint8Array([2])), first.id);

    await store.metadata.saveRevision(first);
    await store.metadata.saveRevision(second);

    const loaded = await store.metadata.getRevision(second.id);
    expect(loaded?.parentIds).toEqual([first.id]);
    expect(loaded?.operation).toBe("local-change");
  });

  it("refuses a revision whose parent is not stored", async () => {
    await store.metadata.saveVault(vault);
    const orphan = localChangeRevision(
      seed("r2", new Uint8Array([2])),
      brand<string, "RevisionId">("never-stored")
    );

    // A dangling edge would make every later ancestry answer quietly wrong.
    await expect(store.metadata.saveRevision(orphan)).rejects.toThrow(/not stored yet/u);
  });

  it("rolls back a failed transaction completely", async () => {
    await store.metadata.saveVault(vault);
    const first = importedRevision(seed("r1", new Uint8Array([1])));

    await expect(
      store.metadata.transaction(async () => {
        await store.metadata.saveRevision(first);
        throw new Error("interrupted mid-sync");
      })
    ).rejects.toThrow(/interrupted/u);

    // This is the reason for SQLite over a JSON file: a crash between two
    // related writes must leave nothing behind, not half a DAG.
    expect(await store.metadata.hasRevision(first.id)).toBe(false);
  });

  it("rebuilds a graph that ancestry logic can classify", async () => {
    await store.metadata.saveVault(vault);
    const a1 = importedRevision(seed("a1", new Uint8Array([1])));
    const a2 = localChangeRevision(seed("a2", new Uint8Array([2])), a1.id);
    const b2 = receivedRevision(seed("b2", new Uint8Array([3])), [a1.id], deviceB);
    for (const revision of [a1, a2, b2]) {
      await store.metadata.saveRevision(revision);
    }

    const graph = await store.metadata.loadGraph(vaultId);
    expect(classifyDivergence(graph, a2.id, b2.id)).toEqual({
      kind: "diverged",
      mergeBases: [a1.id]
    });
  });

  it("answers ancestry through the recursive CTE", async () => {
    await store.metadata.saveVault(vault);
    const a1 = importedRevision(seed("a1", new Uint8Array([1])));
    const a2 = localChangeRevision(seed("a2", new Uint8Array([2])), a1.id);
    const a3 = localChangeRevision(seed("a3", new Uint8Array([3])), a2.id);
    for (const revision of [a1, a2, a3]) {
      await store.metadata.saveRevision(revision);
    }

    expect([...store.metadata.ancestorIdsOf(a3.id)].sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("tracks head moves and the last one", async () => {
    await store.metadata.saveVault(vault);
    const a1 = importedRevision(seed("a1", new Uint8Array([1])));
    await store.metadata.saveRevision(a1);
    await store.metadata.appendHeadEvent({
      vaultId,
      nextRevisionId: a1.id,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      reason: "promote"
    });

    const last = await store.metadata.lastHeadEvent(vaultId);
    expect(last?.nextRevisionId).toBe(a1.id);
    expect(last?.reason).toBe("promote");
  });

  it("remembers what a peer last had", async () => {
    await store.metadata.saveVault(vault);
    const a1 = importedRevision(seed("a1", new Uint8Array([1])));
    await store.metadata.saveRevision(a1);
    await store.metadata.recordPeerHead({
      deviceId: deviceB,
      vaultId,
      headRevisionId: a1.id,
      seenAt: new Date()
    });

    expect(await store.metadata.getPeerHead(deviceB, vaultId)).toBe(a1.id);
  });
});

describe("durability", () => {
  it("survives closing and reopening the application", async () => {
    // The single property M1 exists to deliver: the prototype kept revisions in
    // a useRef Map, so a refresh erased the entire history.
    const bytes = new Uint8Array([10, 20, 30]);
    const hash = await store.blobs.put(bytes);
    await store.metadata.saveVault({ ...vault, headRevisionId: undefined });
    const a1 = importedRevision(seed("a1", bytes));
    const a2 = localChangeRevision(seed("a2", bytes), a1.id);
    await store.metadata.saveRevision(a1);
    await store.metadata.saveRevision(a2);
    await store.metadata.saveVault({ ...vault, headRevisionId: a2.id });

    store.close();
    const reopened = await openLocalStore(root);
    try {
      const reloadedVault = await reopened.metadata.getVault(vaultId);
      expect(reloadedVault?.headRevisionId).toBe(a2.id);

      const revisions = await reopened.metadata.listRevisions(vaultId);
      expect(revisions.map((revision) => revision.id).sort()).toEqual(["a1", "a2"]);

      const graph = await reopened.metadata.loadGraph(vaultId);
      expect(graph.get(brand<string, "RevisionId">("a2"))?.parentIds).toEqual([a1.id]);

      expect(await reopened.blobs.get(hash)).toEqual(bytes);
    } finally {
      reopened.close();
      store = reopened;
    }
  });

  it("clears orphaned temp files left by a crash", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "tmp", `${randomUUID()}.part`), "half written");
    expect(await readdir(join(root, "tmp"))).toHaveLength(1);

    store.close();
    const reopened = await openLocalStore(root);
    try {
      expect(await readdir(join(root, "tmp"))).toEqual([]);
    } finally {
      reopened.close();
      store = reopened;
    }
  });
});

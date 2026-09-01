import type * as kw from "kdbxweb";
import {
  brand,
  systemClock,
  type DeviceId,
  type IdGenerator,
  type RevisionNode,
  type VaultId
} from "@passvault/core";
import { KdbxInterpreter, registerArgon2, uniformCredentials, type KdbxCredentialSet,
  kdbxweb
} from "@passvault/kdbx";
import { openLocalStore, type LocalStore } from "@passvault/storage-node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "./engine.js";

const PASSWORD = "correct horse battery staple";

/** Counter-based ids so failures name a revision instead of a UUID. */
function sequentialIds(prefix: string): IdGenerator {
  let counter = 0;
  const next = (): string => `${prefix}-${(counter += 1)}`;
  return {
    vaultId: () => brand<string, "VaultId">(`${prefix}-vault`),
    revisionId: () => brand<string, "RevisionId">(next()),
    transferId: () => brand<string, "TransferId">(next()),
    conflictId: () => brand<string, "ConflictId">(next()),
    bookmarkId: () => brand<string, "BookmarkId">(next())
  };
}

function credentials(password: string): kw.Credentials {
  return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password), null);
}

async function createVaultBytes(): Promise<Uint8Array> {
  const db = kdbxweb.Kdbx.create(credentials(PASSWORD), "Shared");
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set("Title", "Bank");
  return new Uint8Array(await db.save());
}

/** Simulate the user editing the vault in KeePassXC on one device. */
async function addEntry(bytes: Uint8Array, title: string): Promise<Uint8Array> {
  const db = await kdbxweb.Kdbx.load(new Uint8Array(bytes).buffer, credentials(PASSWORD));
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set("Title", title);
  return new Uint8Array(await db.save());
}

async function titlesIn(bytes: Uint8Array): Promise<readonly string[]> {
  const db = await kdbxweb.Kdbx.load(new Uint8Array(bytes).buffer, credentials(PASSWORD));
  const titles: string[] = [];
  const walk = (group: kw.KdbxGroup): void => {
    for (const entry of group.entries) {
      const title = entry.fields.get("Title");
      titles.push(typeof title === "string" ? title : (title?.getText() ?? ""));
    }
    for (const child of group.groups) {
      walk(child);
    }
  };
  for (const root of db.groups) {
    walk(root);
  }
  return titles.sort();
}

interface Device {
  readonly id: DeviceId;
  readonly store: LocalStore;
  readonly engine: SyncEngine<KdbxCredentialSet>;
  readonly root: string;
}

async function bootDevice(name: string): Promise<Device> {
  const root = await mkdtemp(join(tmpdir(), `passvault-${name}-`));
  const store = await openLocalStore(root);
  const deviceId = brand<string, "DeviceId">(name) as DeviceId;
  return {
    id: deviceId,
    store,
    root,
    engine: new SyncEngine<KdbxCredentialSet>({
      metadata: store.metadata,
      blobs: store.blobs,
      hash: store.hash,
      interpreter: new KdbxInterpreter(),
      clock: systemClock,
      ids: sequentialIds(name),
      deviceId
    })
  };
}

/**
 * Everything a peer would put in a `history-summary` message. Built from the
 * sender's real stored DAG, so the receiver is reasoning about genuine lineage
 * rather than something the test hand-wrote.
 */
async function historySummary(device: Device, vaultId: VaultId): Promise<readonly RevisionNode[]> {
  const revisions = await device.store.metadata.listRevisions(vaultId);
  return revisions.map((revision) => ({ id: revision.id, parentIds: revision.parentIds }));
}

/** Move one revision A -> B the way a transfer would, bytes and declared parents included. */
async function transfer(from: Device, to: Device, vaultId: VaultId, revisionId: string): Promise<void> {
  const revision = await from.store.metadata.getRevision(brand<string, "RevisionId">(revisionId));
  if (revision === undefined) {
    throw new Error(`${from.id} has no revision ${revisionId}`);
  }
  const bytes = await from.store.blobs.get(revision.hash);
  const result = await to.engine.ingestReceivedRevision({
    vaultId,
    revisionId: revision.id,
    declaredParentIds: revision.parentIds,
    declaredHash: revision.hash,
    bytes,
    fromDeviceId: from.id,
    ...(revision.message === undefined ? {} : { message: revision.message })
  });
  if (result.kind === "rejected") {
    throw new Error(`ingest rejected: ${result.reason}`);
  }
}

let deviceA: Device;
let deviceB: Device;

beforeAll(() => {
  registerArgon2();
});

beforeEach(async () => {
  deviceA = await bootDevice("alpha");
  deviceB = await bootDevice("bravo");
});

afterEach(async () => {
  deviceA.store.close();
  deviceB.store.close();
  await rm(deviceA.root, { recursive: true, force: true });
  await rm(deviceB.root, { recursive: true, force: true });
});

describe("two devices sharing a vault", () => {
  it("carries an edit from one device to the other as a fast-forward", async () => {
    const vaultId = brand<string, "VaultId">("alpha-vault") as VaultId;
    const base = await createVaultBytes();
    const { revision: a1 } = await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });

    // B joins the vault by receiving A's history.
    await deviceB.store.metadata.saveVault({ id: vaultId, name: "Shared.kdbx", createdAt: new Date() });
    await transfer(deviceA, deviceB, vaultId, a1.id);
    await deviceB.engine.fastForward(vaultId, a1.id);

    // A edits in KeePassXC.
    const edited = await addEntry(base, "Email");
    const change = await deviceA.engine.recordLocalChange(vaultId, edited);
    expect(change.kind).toBe("recorded");
    if (change.kind !== "recorded") {
      return;
    }

    await transfer(deviceA, deviceB, vaultId, change.revision.id);
    const divergence = await deviceB.engine.divergenceWithPeer({
      vaultId,
      remoteNodes: await historySummary(deviceA, vaultId),
      remoteHead: change.revision.id
    });

    expect(divergence.kind).toBe("remote-ahead");
    await deviceB.engine.fastForward(vaultId, change.revision.id);
    expect(await titlesIn(await deviceB.engine.bytesOf(change.revision.id))).toEqual(["Bank", "Email"]);
  }, 60_000);

  it("detects a real fork and merges both sides into one revision", async () => {
    const vaultId = brand<string, "VaultId">("alpha-vault") as VaultId;
    const base = await createVaultBytes();
    const { revision: a1 } = await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });

    await deviceB.store.metadata.saveVault({ id: vaultId, name: "Shared.kdbx", createdAt: new Date() });
    await transfer(deviceA, deviceB, vaultId, a1.id);
    await deviceB.engine.fastForward(vaultId, a1.id);

    // Both devices edit offline, from the same starting point.
    const aEdit = await deviceA.engine.recordLocalChange(vaultId, await addEntry(base, "Email"));
    const bEdit = await deviceB.engine.recordLocalChange(vaultId, await addEntry(base, "Router"));
    expect(aEdit.kind).toBe("recorded");
    expect(bEdit.kind).toBe("recorded");
    if (aEdit.kind !== "recorded" || bEdit.kind !== "recorded") {
      return;
    }

    // They reconnect. B pulls A's branch.
    await transfer(deviceA, deviceB, vaultId, aEdit.revision.id);
    const divergence = await deviceB.engine.divergenceWithPeer({
      vaultId,
      remoteNodes: await historySummary(deviceA, vaultId),
      remoteHead: aEdit.revision.id
    });

    expect(divergence).toEqual({ kind: "diverged", mergeBases: [a1.id] });

    const merged = await deviceB.engine.merge({
      vaultId,
      baseRevisionId: bEdit.revision.id,
      incomingRevisionIds: [aEdit.revision.id],
      credentials: uniformCredentials(PASSWORD, 1)
    });

    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") {
      return;
    }
    expect(merged.revision.parentIds).toEqual([bEdit.revision.id, aEdit.revision.id]);
    expect(await titlesIn(await deviceB.engine.bytesOf(merged.revision.id))).toEqual([
      "Bank",
      "Email",
      "Router"
    ]);

    // A merge does not silently become the active vault.
    const beforePromote = await deviceB.store.metadata.getVault(vaultId);
    expect(beforePromote?.headRevisionId).toBe(bEdit.revision.id);

    await deviceB.engine.promote(vaultId, merged.revision.id);
    const afterPromote = await deviceB.store.metadata.getVault(vaultId);
    expect(afterPromote?.headRevisionId).toBe(merged.revision.id);
  }, 60_000);

  it("preserves the sender's lineage instead of re-parenting onto the local head", async () => {
    const vaultId = brand<string, "VaultId">("alpha-vault") as VaultId;
    const base = await createVaultBytes();
    const { revision: a1 } = await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });

    await deviceB.store.metadata.saveVault({ id: vaultId, name: "Shared.kdbx", createdAt: new Date() });
    await transfer(deviceA, deviceB, vaultId, a1.id);
    await deviceB.engine.fastForward(vaultId, a1.id);

    const aEdit = await deviceA.engine.recordLocalChange(vaultId, await addEntry(base, "Email"));
    const bEdit = await deviceB.engine.recordLocalChange(vaultId, await addEntry(base, "Router"));
    if (aEdit.kind !== "recorded" || bEdit.kind !== "recorded") {
      throw new Error("setup failed");
    }

    // B's head is now bEdit. Ingesting A's revision must not adopt that as parent.
    await transfer(deviceA, deviceB, vaultId, aEdit.revision.id);
    const stored = await deviceB.store.metadata.getRevision(aEdit.revision.id);

    expect(stored?.parentIds).toEqual([a1.id]);
    expect(stored?.parentIds).not.toContain(bEdit.revision.id);
    expect(stored?.originDeviceId).toBe(deviceA.id);
  }, 60_000);

  it("rejects bytes that do not match the declared hash", async () => {
    const vaultId = brand<string, "VaultId">("alpha-vault") as VaultId;
    const base = await createVaultBytes();
    const { revision: a1 } = await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });
    await deviceB.store.metadata.saveVault({ id: vaultId, name: "Shared.kdbx", createdAt: new Date() });

    const result = await deviceB.engine.ingestReceivedRevision({
      vaultId,
      revisionId: a1.id,
      declaredParentIds: [],
      declaredHash: a1.hash,
      bytes: new Uint8Array([0, 0, 0]),
      fromDeviceId: deviceA.id
    });

    expect(result).toEqual({ kind: "rejected", reason: "received bytes do not match the declared hash" });
    expect(await deviceB.store.metadata.hasRevision(a1.id)).toBe(false);
  }, 60_000);

  it("refuses a revision whose parents have not arrived yet", async () => {
    const vaultId = brand<string, "VaultId">("alpha-vault") as VaultId;
    const base = await createVaultBytes();
    await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });
    const aEdit = await deviceA.engine.recordLocalChange(vaultId, await addEntry(base, "Email"));
    if (aEdit.kind !== "recorded") {
      throw new Error("setup failed");
    }
    await deviceB.store.metadata.saveVault({ id: vaultId, name: "Shared.kdbx", createdAt: new Date() });

    // Sending a child before its parent must fail loudly, not create a hole.
    await expect(transfer(deviceA, deviceB, vaultId, aEdit.revision.id)).rejects.toThrow(
      /must be received before/u
    );
  }, 60_000);

  it("ignores a file-watcher event that reports identical bytes", async () => {
    const vaultId = brand<string, "VaultId">("alpha-vault") as VaultId;
    const base = await createVaultBytes();
    const { revision: a1 } = await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });

    const result = await deviceA.engine.recordLocalChange(vaultId, base);

    expect(result).toEqual({ kind: "unchanged", revisionId: a1.id });
    expect(await deviceA.store.metadata.listRevisions(vaultId)).toHaveLength(1);
  }, 60_000);
});

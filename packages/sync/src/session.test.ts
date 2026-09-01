import type * as kw from "kdbxweb";
import {
  brand,
  encodeMessage,
  systemClock,
  type DeviceId,
  type IdGenerator,
  type PeerLink,
  type VaultId
} from "@passvault/core";
import {
  createAuthenticator,
  generateDeviceKeyPair,
  toBase64,
  trustStoreFromMap,
  type DeviceKeyPair,
  type PairedDevice,
  type TrustStore
} from "@passvault/identity";
import { KdbxInterpreter, registerArgon2, type KdbxCredentialSet,
  kdbxweb
} from "@passvault/kdbx";
import { openLocalStore, type LocalStore } from "@passvault/storage-node";
import { createMemoryLinkPair } from "@passvault/transport";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "./engine.js";
import { SyncSession } from "./session.js";

const PASSWORD = "correct horse battery staple";
const VAULT_ID = brand<string, "VaultId">("alpha-vault") as VaultId;

function sequentialIds(prefix: string): IdGenerator {
  let counter = 0;
  const next = (): string => `${prefix}-${(counter += 1)}`;
  return {
    // Per-device, so a test can reproduce two devices importing the same file
    // and ending up with different vault ids. deviceA's matches VAULT_ID.
    vaultId: () => brand<string, "VaultId">(`${prefix}-vault`),
    revisionId: () => brand<string, "RevisionId">(next()),
    transferId: () => brand<string, "TransferId">(next()),
    conflictId: () => brand<string, "ConflictId">(next()),
    bookmarkId: () => brand<string, "BookmarkId">(next())
  };
}

function credentials(): kw.Credentials {
  return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
}

async function createVaultBytes(entryCount = 1): Promise<Uint8Array> {
  const db = kdbxweb.Kdbx.create(credentials(), "Shared");
  for (let index = 0; index < entryCount; index += 1) {
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", `Entry ${index}`);
    entry.fields.set("Notes", "x".repeat(256));
  }
  return new Uint8Array(await db.save());
}

async function addEntry(bytes: Uint8Array, title: string): Promise<Uint8Array> {
  const db = await kdbxweb.Kdbx.load(new Uint8Array(bytes).buffer, credentials());
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set("Title", title);
  return new Uint8Array(await db.save());
}

async function titlesIn(bytes: Uint8Array): Promise<readonly string[]> {
  const db = await kdbxweb.Kdbx.load(new Uint8Array(bytes).buffer, credentials());
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
  readonly name: string;
  readonly store: LocalStore;
  readonly engine: SyncEngine<KdbxCredentialSet>;
  readonly root: string;
  readonly keyPair: DeviceKeyPair;
  readonly trust: TrustStore;
  readonly known: Map<DeviceId, PairedDevice>;
}

async function bootDevice(name: string): Promise<Device> {
  const root = await mkdtemp(join(tmpdir(), `keepass-session-${name}-`));
  const store = await openLocalStore(root);
  const keyPair = generateDeviceKeyPair();
  const known = new Map<DeviceId, PairedDevice>();
  // Revisions are still stamped with a readable id so failures name a device.
  const deviceId = brand<string, "DeviceId">(name) as DeviceId;
  return {
    id: deviceId,
    name: `${name}-device`,
    store,
    root,
    keyPair,
    known,
    trust: trustStoreFromMap(known),
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

/** Pin each device's key in the other's trust store, as pairing would. */
function pairDevices(one: Device, two: Device): void {
  one.known.set(two.keyPair.deviceId, {
    deviceId: two.keyPair.deviceId,
    publicKey: two.keyPair.publicKey,
    name: two.name,
    trust: "paired",
    pairedAt: new Date("2026-01-01T00:00:00.000Z")
  });
  two.known.set(one.keyPair.deviceId, {
    deviceId: one.keyPair.deviceId,
    publicKey: one.keyPair.publicKey,
    name: one.name,
    trust: "paired",
    pairedAt: new Date("2026-01-01T00:00:00.000Z")
  });
}

function authFor(device: Device, pairingMode = false) {
  return createAuthenticator({
    keyPair: device.keyPair,
    deviceName: device.name,
    trustStore: device.trust,
    pairingMode
  });
}

function session(
  device: Device,
  link: PeerLink,
  options?: { chunkBytes?: number; highWaterBytes?: number; pairingMode?: boolean }
) {
  const { pairingMode, ...sessionOptions } = options ?? {};
  return new SyncSession<KdbxCredentialSet>({
    link,
    engine: device.engine,
    vaultId: VAULT_ID,
    auth: authFor(device, pairingMode),
    options: { timeoutMs: 10_000, ...sessionOptions }
  });
}

/** Give B the vault root so both devices share a history to diverge from. */
async function seedBothDevices(base: Uint8Array): Promise<string> {
  const { revision } = await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });
  await deviceB.store.metadata.saveVault({ id: VAULT_ID, name: "Shared.kdbx", createdAt: new Date() });
  await deviceB.engine.ingestReceivedRevision({
    vaultId: VAULT_ID,
    revisionId: revision.id,
    declaredParentIds: [],
    declaredHash: revision.hash,
    bytes: base,
    fromDeviceId: deviceA.id
  });
  await deviceB.engine.fastForward(VAULT_ID, revision.id);
  return revision.id;
}

let deviceA: Device;
let deviceB: Device;

beforeAll(() => {
  registerArgon2();
});

beforeEach(async () => {
  deviceA = await bootDevice("alpha");
  deviceB = await bootDevice("bravo");
  pairDevices(deviceA, deviceB);
});

afterEach(async () => {
  deviceA.store.close();
  deviceB.store.close();
  await rm(deviceA.root, { recursive: true, force: true });
  await rm(deviceB.root, { recursive: true, force: true });
});

describe("sync session", () => {
  it("carries a new revision to the peer and reports a fast-forward", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    const edit = await deviceA.engine.recordLocalChange(VAULT_ID, await addEntry(base, "Email"));
    if (edit.kind !== "recorded") {
      throw new Error("setup failed");
    }

    const { a, b } = createMemoryLinkPair();
    const [fromA, fromB] = await Promise.all([
      session(deviceA, a).run(),
      session(deviceB, b).run()
    ]);

    expect(fromB.received).toEqual([edit.revision.id]);
    expect(fromA.sent).toEqual([edit.revision.id]);
    expect(fromB.divergence.kind).toBe("remote-ahead");
    expect(fromA.divergence.kind).toBe("local-ahead");
    expect(fromB.missing).toEqual([]);

    expect(await titlesIn(await deviceB.engine.bytesOf(edit.revision.id))).toContain("Email");
  }, 60_000);

  it("exchanges both branches of a fork and reports divergence with the merge base", async () => {
    const base = await createVaultBytes();
    const rootId = await seedBothDevices(base);

    const aEdit = await deviceA.engine.recordLocalChange(VAULT_ID, await addEntry(base, "Email"));
    const bEdit = await deviceB.engine.recordLocalChange(VAULT_ID, await addEntry(base, "Router"));
    if (aEdit.kind !== "recorded" || bEdit.kind !== "recorded") {
      throw new Error("setup failed");
    }

    const { a, b } = createMemoryLinkPair();
    const [fromA, fromB] = await Promise.all([
      session(deviceA, a).run(),
      session(deviceB, b).run()
    ]);

    // Each side pulled the other's branch in a single session.
    expect(fromA.received).toEqual([bEdit.revision.id]);
    expect(fromB.received).toEqual([aEdit.revision.id]);
    expect(fromA.divergence).toEqual({ kind: "diverged", mergeBases: [rootId] });
    expect(fromB.divergence).toEqual({ kind: "diverged", mergeBases: [rootId] });

    // Neither head moved: resolving a fork is a decision, not a side effect.
    expect((await deviceA.store.metadata.getVault(VAULT_ID))?.headRevisionId).toBe(aEdit.revision.id);
    expect((await deviceB.store.metadata.getVault(VAULT_ID))?.headRevisionId).toBe(bEdit.revision.id);
  }, 60_000);

  it("does nothing when both devices are already in step", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    const { a, b } = createMemoryLinkPair();
    const [fromA, fromB] = await Promise.all([
      session(deviceA, a).run(),
      session(deviceB, b).run()
    ]);

    expect(fromA.received).toEqual([]);
    expect(fromB.received).toEqual([]);
    expect(fromA.divergence).toEqual({ kind: "equal" });
    expect(fromB.divergence).toEqual({ kind: "equal" });
  }, 60_000);

  it("sends bytes binary, not base64", async () => {
    const base = await createVaultBytes(20);
    await seedBothDevices(base);
    const edit = await deviceA.engine.recordLocalChange(VAULT_ID, await addEntry(base, "Email"));
    if (edit.kind !== "recorded") {
      throw new Error("setup failed");
    }

    const { a, b, stats } = createMemoryLinkPair();
    await Promise.all([session(deviceA, a).run(), session(deviceB, b).run()]);

    // Base64 in JSON would put this at roughly 1.37x the payload. Binary framing
    // costs 8 bytes per chunk and nothing else.
    const payloadBytes = edit.revision.sizeBytes;
    expect(stats.aBulk.totalBytesSent).toBeGreaterThanOrEqual(payloadBytes);
    expect(stats.aBulk.totalBytesSent).toBeLessThan(payloadBytes * 1.05);
  }, 60_000);

  it("applies backpressure instead of filling the channel without limit", async () => {
    const base = await createVaultBytes(60);
    await seedBothDevices(base);
    const edit = await deviceA.engine.recordLocalChange(VAULT_ID, await addEntry(base, "Email"));
    if (edit.kind !== "recorded") {
      throw new Error("setup failed");
    }

    const chunkBytes = 512;
    const highWaterBytes = 2048;
    const { a, b, stats } = createMemoryLinkPair({ lowWaterBytes: 1024 });
    await Promise.all([
      session(deviceA, a, { chunkBytes, highWaterBytes }).run(),
      session(deviceB, b, { chunkBytes, highWaterBytes }).run()
    ]);

    // The sender pauses once past the high-water mark, so the queue can never
    // exceed it by more than the single chunk that was already in flight.
    expect(stats.aBulk.peakBufferedAmount).toBeLessThanOrEqual(
      highWaterBytes + chunkBytes + 8
    );
    expect(edit.revision.sizeBytes).toBeGreaterThan(highWaterBytes);
  }, 60_000);

  it("refuses a peer speaking a different protocol version", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    const { a, b } = createMemoryLinkPair();
    // Stand in for a peer from a future build.
    b.control.onMessage(() => undefined);
    b.control.send(
      encodeMessage({
        type: "hello",
        protocolVersion: 99,
        deviceId: deviceB.keyPair.deviceId,
        deviceName: "future-device",
        publicKey: toBase64(deviceB.keyPair.publicKey),
        nonce: toBase64(new Uint8Array(32))
      })
    );

    await expect(session(deviceA, a).run()).rejects.toThrow(/protocol version 99/u);
  }, 60_000);

  it("fails the session on a malformed control message rather than throwing mid-write", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    const { a, b } = createMemoryLinkPair();
    b.control.onMessage(() => undefined);
    b.control.send("{\"type\":\"history-summary\",\"vaultId\":\"v\",\"revisions\":\"not-an-array\"}");

    await expect(session(deviceA, a).run()).rejects.toThrow(/revisions array/u);
  }, 60_000);

  it("times out on a peer that connects and says nothing", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    const { a, b } = createMemoryLinkPair();
    b.control.onMessage(() => undefined);

    await expect(
      new SyncSession<KdbxCredentialSet>({
        link: a,
        engine: deviceA.engine,
        vaultId: VAULT_ID,
        auth: authFor(deviceA),
        options: { timeoutMs: 150 }
      }).run()
    ).rejects.toThrow(/timed out waiting for hello/u);
  }, 60_000);

  it("reports progress events in order", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);
    const edit = await deviceA.engine.recordLocalChange(VAULT_ID, await addEntry(base, "Email"));
    if (edit.kind !== "recorded") {
      throw new Error("setup failed");
    }

    const kinds: string[] = [];
    const { a, b } = createMemoryLinkPair();
    await Promise.all([
      session(deviceA, a).run(),
      new SyncSession<KdbxCredentialSet>({
        link: b,
        engine: deviceB.engine,
        vaultId: VAULT_ID,
        auth: authFor(deviceB),
        options: { timeoutMs: 10_000 },
        onEvent: (event) => kinds.push(event.kind)
      }).run()
    ]);

    expect(kinds[0]).toBe("handshake");
    expect(kinds).toContain("requested");
    expect(kinds).toContain("received");
  }, 60_000);
});

describe("peer authentication", () => {
  /** Both sides must fail, or the "rejection" only stopped one direction. */
  async function expectBothRejected(
    runA: Promise<unknown>,
    runB: Promise<unknown>,
    pattern: RegExp
  ): Promise<void> {
    const [a, b] = await Promise.allSettled([runA, runB]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    const reasons = [a, b]
      .map((result) => (result.status === "rejected" ? String(result.reason) : ""))
      .join(" | ");
    expect(reasons).toMatch(pattern);
  }

  it("refuses a device that was never paired", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);
    // Undo the pairing the fixture set up: strangers must not sync.
    deviceA.known.clear();
    deviceB.known.clear();

    const { a, b } = createMemoryLinkPair();
    await expectBothRejected(session(deviceA, a).run(), session(deviceB, b).run(), /not paired/u);
  }, 60_000);

  it("refuses a device whose key changed since pairing", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    // Same device id on record, different key presented — impersonation, or a
    // reinstall. Either way a human must re-pair deliberately.
    const impostor = generateDeviceKeyPair();
    const pinned = deviceA.known.get(deviceB.keyPair.deviceId);
    if (pinned === undefined) {
      throw new Error("fixture did not pair the devices");
    }
    deviceA.known.set(deviceB.keyPair.deviceId, { ...pinned, publicKey: impostor.publicKey });

    const { a, b } = createMemoryLinkPair();
    await expectBothRejected(session(deviceA, a).run(), session(deviceB, b).run(), /key has changed/u);
  }, 60_000);

  it("refuses a revoked device", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);
    await deviceA.trust.revoke(deviceB.keyPair.deviceId);

    const { a, b } = createMemoryLinkPair();
    await expectBothRejected(session(deviceA, a).run(), session(deviceB, b).run(), /revoked/u);
  }, 60_000);

  it("accepts and pins an unknown device while pairing", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);
    deviceA.known.clear();
    deviceB.known.clear();

    const { a, b } = createMemoryLinkPair();
    await Promise.all([
      session(deviceA, a, { pairingMode: true }).run(),
      session(deviceB, b, { pairingMode: true }).run()
    ]);

    // After pairing, each side holds the other's real key — so the next session
    // succeeds without pairing mode, and an impostor would not.
    expect(deviceA.known.get(deviceB.keyPair.deviceId)?.publicKey).toEqual(deviceB.keyPair.publicKey);
    expect(deviceB.known.get(deviceA.keyPair.deviceId)?.publicKey).toEqual(deviceA.keyPair.publicKey);
  }, 60_000);

  it("refuses an identity whose id is not the hash of its key", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    const impostor = generateDeviceKeyPair();
    const { a, b } = createMemoryLinkPair();
    b.control.onMessage(() => undefined);
    // Claim a paired device id while holding a different key.
    b.control.send(
      encodeMessage({
        type: "hello",
        protocolVersion: 1,
        deviceId: deviceB.keyPair.deviceId,
        deviceName: "impostor",
        publicKey: toBase64(impostor.publicKey),
        nonce: toBase64(new Uint8Array(32))
      })
    );
    b.control.send(encodeMessage({ type: "auth", signature: toBase64(new Uint8Array(64)) }));

    await expect(session(deviceA, a).run()).rejects.toThrow(/does not match the presented public key/u);
  }, 60_000);

  it("refuses a peer that cannot sign the challenge", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);

    const { a, b } = createMemoryLinkPair();
    b.control.onMessage(() => undefined);
    // Correct identity, but no private key to prove it with.
    b.control.send(
      encodeMessage({
        type: "hello",
        protocolVersion: 1,
        deviceId: deviceB.keyPair.deviceId,
        deviceName: deviceB.name,
        publicKey: toBase64(deviceB.keyPair.publicKey),
        nonce: toBase64(new Uint8Array(32))
      })
    );
    b.control.send(encodeMessage({ type: "auth", signature: toBase64(new Uint8Array(64)) }));

    await expect(session(deviceA, a).run()).rejects.toThrow(/signature did not verify/u);
  }, 60_000);

  it("exchanges no vault information before authentication succeeds", async () => {
    const base = await createVaultBytes();
    await seedBothDevices(base);
    deviceA.known.clear();
    deviceB.known.clear();

    const sent: string[] = [];
    const { a, b } = createMemoryLinkPair();
    const original = a.control.send.bind(a.control);
    (a.control as { send: (data: string) => void }).send = (data: string) => {
      sent.push(data);
      original(data);
    };

    await Promise.allSettled([session(deviceA, a).run(), session(deviceB, b).run()]);

    // A rejected peer learns our device name and key, which are public anyway,
    // and nothing whatsoever about the vault.
    const traffic = sent.join("\n");
    expect(traffic).not.toContain("vault-summary");
    expect(traffic).not.toContain("history-summary");
    expect(traffic).not.toContain(VAULT_ID);
  }, 60_000);
});

describe("a device joining for the first time", () => {
  it("syncs a whole history to a peer that holds nothing", async () => {
    // The most common real scenario, and the one the session originally
    // refused: a device paired a minute ago has no head revision to advertise.
    const base = await createVaultBytes();
    const { revision: root } = await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });
    const edit = await deviceA.engine.recordLocalChange(VAULT_ID, await addEntry(base, "Email"));
    if (edit.kind !== "recorded") {
      throw new Error("setup failed");
    }
    await deviceB.store.metadata.saveVault({ id: VAULT_ID, name: "Shared.kdbx", createdAt: new Date() });

    const { a, b } = createMemoryLinkPair();
    const [fromA, fromB] = await Promise.all([
      session(deviceA, a).run(),
      session(deviceB, b).run()
    ]);

    // Parents first, so the empty side never holds a dangling edge.
    expect(fromB.received).toEqual([root.id, edit.revision.id]);
    expect(fromB.divergence.kind).toBe("remote-ahead");
    expect(fromA.divergence.kind).toBe("local-ahead");
    expect(fromA.remoteHead).toBeUndefined();

    // "remote-ahead" is what tells the caller to adopt the peer's history.
    await deviceB.engine.fastForward(VAULT_ID, edit.revision.id);
    expect((await deviceB.store.metadata.getVault(VAULT_ID))?.headRevisionId).toBe(edit.revision.id);
    expect(await titlesIn(await deviceB.engine.bytesOf(edit.revision.id))).toContain("Email");
  }, 60_000);

  it("handles both devices being empty without erroring", async () => {
    await deviceA.store.metadata.saveVault({ id: VAULT_ID, name: "Shared.kdbx", createdAt: new Date() });
    await deviceB.store.metadata.saveVault({ id: VAULT_ID, name: "Shared.kdbx", createdAt: new Date() });

    const { a, b } = createMemoryLinkPair();
    const [fromA, fromB] = await Promise.all([
      session(deviceA, a).run(),
      session(deviceB, b).run()
    ]);

    expect(fromA.divergence).toEqual({ kind: "equal" });
    expect(fromB.received).toEqual([]);
  }, 60_000);

  it("refuses a peer syncing a vault this device does not track", async () => {
    const base = await createVaultBytes();
    await deviceA.engine.importVault({ name: "Shared.kdbx", bytes: base });
    // deviceB has no vault row at all — distinct from having one that is empty.

    const { a, b } = createMemoryLinkPair();
    const [resultA, resultB] = await Promise.allSettled([
      session(deviceA, a).run(),
      session(deviceB, b).run()
    ]);
    expect(resultB.status).toBe("rejected");
    expect(resultA.status).toBe("rejected");
  }, 60_000);
});

describe("vault identity", () => {
  it("lets a device with no vault adopt the peer's, id and all", async () => {
    // The join path. Minting a local id here is what produced two un-syncable
    // copies of the same file.
    const base = await createVaultBytes();
    const { vault, revision } = await deviceA.engine.importVault({
      name: "Passwords.kdbx",
      bytes: base
    });
    // deviceB has nothing at all — no vault row, no id.

    const { a, b } = createMemoryLinkPair();
    const adopted: string[] = [];
    const [fromA, fromB] = await Promise.all([
      new SyncSession<KdbxCredentialSet>({
        link: a,
        engine: deviceA.engine,
        vaultId: vault.id,
        auth: authFor(deviceA),
        options: { timeoutMs: 10_000 }
      }).run(),
      new SyncSession<KdbxCredentialSet>({
        link: b,
        engine: deviceB.engine,
        auth: authFor(deviceB),
        options: { timeoutMs: 10_000 },
        onEvent: (event) => {
          if (event.kind === "adopted-vault") {
            adopted.push(event.name);
          }
        }
      }).run()
    ]);

    expect(adopted).toEqual(["Passwords.kdbx"]);
    expect(fromB.vaultId).toBe(vault.id);
    expect(fromA.vaultId).toBe(vault.id);
    expect(fromB.received).toEqual([revision.id]);

    const joined = await deviceB.store.metadata.getVault(vault.id);
    expect(joined?.name).toBe("Passwords.kdbx");
    // Joined, not imported: no file on this device yet.
    expect(joined?.kdbxPath).toBeUndefined();
  }, 60_000);

  it("explains the mismatch when both devices imported the same file separately", async () => {
    const base = await createVaultBytes();
    const a1 = await deviceA.engine.importVault({ name: "Passwords.kdbx", bytes: base });
    const b1 = await deviceB.engine.importVault({ name: "Passwords.kdbx", bytes: base });
    expect(a1.vault.id).not.toBe(b1.vault.id);

    const { a, b } = createMemoryLinkPair();
    const [resultA, resultB] = await Promise.allSettled([
      new SyncSession<KdbxCredentialSet>({
        link: a,
        engine: deviceA.engine,
        vaultId: a1.vault.id,
        auth: authFor(deviceA),
        options: { timeoutMs: 10_000 }
      }).run(),
      new SyncSession<KdbxCredentialSet>({
        link: b,
        engine: deviceB.engine,
        vaultId: b1.vault.id,
        auth: authFor(deviceB),
        options: { timeoutMs: 10_000 }
      }).run()
    ]);

    expect(resultA.status).toBe("rejected");
    expect(resultB.status).toBe("rejected");
    // The old message said only "peer is syncing a different vault", which gave
    // the user nothing to act on.
    const reason = resultA.status === "rejected" ? String(resultA.reason) : "";
    expect(reason).toMatch(/shared from one device and joined on the other/u);
  }, 60_000);

  it("refuses when neither device has a vault", async () => {
    const { a, b } = createMemoryLinkPair();
    const [resultA] = await Promise.allSettled([
      new SyncSession<KdbxCredentialSet>({
        link: a,
        engine: deviceA.engine,
        auth: authFor(deviceA),
        options: { timeoutMs: 10_000 }
      }).run(),
      new SyncSession<KdbxCredentialSet>({
        link: b,
        engine: deviceB.engine,
        auth: authFor(deviceB),
        options: { timeoutMs: 10_000 }
      }).run()
    ]);
    expect(resultA.status).toBe("rejected");
    if (resultA.status === "rejected") {
      expect(String(resultA.reason)).toMatch(/neither device is tracking a vault/u);
    }
  }, 60_000);

  it("syncs normally on the second session, after adoption", async () => {
    const base = await createVaultBytes();
    const { vault } = await deviceA.engine.importVault({ name: "Passwords.kdbx", bytes: base });

    const first = createMemoryLinkPair();
    await Promise.all([
      new SyncSession<KdbxCredentialSet>({
        link: first.a, engine: deviceA.engine, vaultId: vault.id,
        auth: authFor(deviceA), options: { timeoutMs: 10_000 }
      }).run(),
      new SyncSession<KdbxCredentialSet>({
        link: first.b, engine: deviceB.engine,
        auth: authFor(deviceB), options: { timeoutMs: 10_000 }
      }).run()
    ]);

    const edit = await deviceA.engine.recordLocalChange(vault.id, await addEntry(base, "Email"));
    if (edit.kind !== "recorded") {
      throw new Error("setup failed");
    }

    // Both sides now name the vault identically, so this is an ordinary sync.
    const second = createMemoryLinkPair();
    const [, fromB] = await Promise.all([
      new SyncSession<KdbxCredentialSet>({
        link: second.a, engine: deviceA.engine, vaultId: vault.id,
        auth: authFor(deviceA), options: { timeoutMs: 10_000 }
      }).run(),
      new SyncSession<KdbxCredentialSet>({
        link: second.b, engine: deviceB.engine, vaultId: vault.id,
        auth: authFor(deviceB), options: { timeoutMs: 10_000 }
      }).run()
    ]);

    expect(fromB.received).toEqual([edit.revision.id]);
    expect(fromB.divergence.kind).toBe("remote-ahead");
  }, 60_000);
});

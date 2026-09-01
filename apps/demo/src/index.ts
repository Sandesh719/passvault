import type * as kw from "kdbxweb";
import { brand, cryptoIdGenerator, systemClock, type DeviceId, type VaultId } from "@passvault/core";
import {
  createAuthenticator,
  decodePairingOffer,
  encodePairingOffer,
  generateDeviceKeyPair,
  shortAuthenticationString,
  trustStoreFromMap,
  type DeviceKeyPair,
  type PairedDevice
} from "@passvault/identity";
import { KdbxInterpreter, registerArgon2, uniformCredentials, type KdbxCredentialSet,
  kdbxweb
} from "@passvault/kdbx";
import {
  VaultFileWatcher,
  openLocalStore,
  readVaultFile,
  writeVaultFileAtomic,
  type LocalStore
} from "@passvault/storage-node";
import { SyncEngine, SyncSession } from "@passvault/sync";
import { createMemoryLinkPair } from "@passvault/transport";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An end-to-end demonstration of the whole system, headless.
 *
 * Everything here is the real thing: real KDBX files on disk, the real file
 * watcher, real device keys, the real authenticated session protocol, real
 * SQLite storage. The single substitution is the transport — an in-memory link
 * pair stands in for WebRTC, because a data channel needs two browser
 * processes and a signaling server, and everything above the transport is what
 * this is here to prove.
 */

const PASSWORD = "correct horse battery staple";

const ok = (text: string): string => `[32m${text}[0m`;
const dim = (text: string): string => `[2m${text}[0m`;
const bold = (text: string): string => `[1m${text}[0m`;
const warn = (text: string): string => `[33m${text}[0m`;

let step = 0;
function say(action: string, detail: string): void {
  step += 1;
  console.log(`${dim(String(step).padStart(2, " "))}  ${action.padEnd(46)} ${dim(detail)}`);
}

interface Device {
  readonly name: string;
  readonly keyPair: DeviceKeyPair;
  readonly known: Map<DeviceId, PairedDevice>;
  readonly store: LocalStore;
  readonly engine: SyncEngine<KdbxCredentialSet>;
  readonly root: string;
}

async function bootDevice(name: string): Promise<Device> {
  const root = await mkdtemp(join(tmpdir(), `keepass-demo-${name}-`));
  const store = await openLocalStore(root);
  const keyPair = generateDeviceKeyPair();
  const known = new Map<DeviceId, PairedDevice>();
  return {
    name,
    keyPair,
    known,
    store,
    root,
    engine: new SyncEngine<KdbxCredentialSet>({
      metadata: store.metadata,
      blobs: store.blobs,
      hash: store.hash,
      interpreter: new KdbxInterpreter(),
      clock: systemClock,
      ids: cryptoIdGenerator,
      deviceId: keyPair.deviceId
    })
  };
}

function credentials(): kw.Credentials {
  return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
}

async function newVaultBytes(): Promise<Uint8Array> {
  const db = kdbxweb.Kdbx.create(credentials(), "Shared");
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set("Title", "Bank");
  entry.fields.set("UserName", "vikas");
  entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("s3cret"));
  return new Uint8Array(await db.save());
}

/** Stands in for the user adding an entry inside KeePassXC. */
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

function authFor(device: Device, pairingMode: boolean) {
  return createAuthenticator({
    keyPair: device.keyPair,
    deviceName: device.name,
    trustStore: trustStoreFromMap(device.known),
    pairingMode
  });
}

async function sync(
  a: Device,
  b: Device,
  vaultId: VaultId,
  pairingMode = false
): Promise<{ readonly a: Awaited<ReturnType<SyncSession<KdbxCredentialSet>["run"]>>; readonly b: Awaited<ReturnType<SyncSession<KdbxCredentialSet>["run"]>> }> {
  const link = createMemoryLinkPair();
  const [resultA, resultB] = await Promise.all([
    new SyncSession<KdbxCredentialSet>({
      link: link.a,
      engine: a.engine,
      vaultId,
      auth: authFor(a, pairingMode),
      options: { timeoutMs: 15_000 }
    }).run(),
    new SyncSession<KdbxCredentialSet>({
      link: link.b,
      engine: b.engine,
      vaultId,
      auth: authFor(b, pairingMode),
      options: { timeoutMs: 15_000 }
    }).run()
  ]);
  return { a: resultA, b: resultB };
}

function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(() => void tick(), 50);
    };
    void tick();
  });
}

async function main(): Promise<void> {
  console.log(`\n${bold("PassVault — end-to-end demonstration")}`);
  console.log(dim("Real vault files, real device keys, real authenticated protocol, real storage.\n"));

  registerArgon2();

  const alpha = await bootDevice("Laptop");
  const bravo = await bootDevice("Desktop");
  const shared = await mkdtemp(join(tmpdir(), "passvault-demo-vaults-"));
  const alphaVaultPath = join(shared, "Alpha.kdbx");
  const bravoVaultPath = join(shared, "Bravo.kdbx");
  let failures = 0;

  const check = (label: string, condition: boolean, detail: string): void => {
    if (condition) {
      console.log(`    ${ok("✓")} ${label} ${dim(detail)}`);
    } else {
      failures += 1;
      console.log(`    [31m✗ ${label}[0m ${detail}`);
    }
  };

  try {
    // ---- a real vault on disk ----------------------------------------
    const base = await newVaultBytes();
    await writeFile(alphaVaultPath, base);
    await writeFile(bravoVaultPath, base);
    say("Created a KDBX4 vault", `${base.byteLength} bytes, Argon2id, 1 entry`);

    const { vault, revision: root } = await alpha.engine.importVault({
      name: "Shared.kdbx",
      bytes: base,
      kdbxPath: alphaVaultPath
    });
    const vaultId = vault.id;
    say(`${alpha.name} started tracking it`, `revision ${root.id.slice(0, 8)}`);

    // ---- watch the file the way the desktop app does -------------------
    const alphaWatcher = new VaultFileWatcher({
      vaultPath: alphaVaultPath,
      debounceMs: 150,
      onChange: async (bytes) => {
        await alpha.engine.recordLocalChange(vaultId, bytes);
      }
    });
    alphaWatcher.start();

    // ---- pairing -------------------------------------------------------
    const code = encodePairingOffer({
      deviceId: alpha.keyPair.deviceId,
      publicKey: alpha.keyPair.publicKey,
      name: alpha.name,
      roomId: "demo-room",
      inviteToken: "demo-token",
      signalUrl: "ws://localhost:8787/signal"
    });
    const parsed = decodePairingOffer(code);
    if (!parsed.ok) {
      throw new Error(`pairing code did not round-trip: ${parsed.reason}`);
    }
    const sasAlpha = shortAuthenticationString(alpha.keyPair.publicKey, bravo.keyPair.publicKey);
    const sasBravo = shortAuthenticationString(bravo.keyPair.publicKey, alpha.keyPair.publicKey);
    say("Generated a pairing code", `${code.slice(0, 44)}…`);
    say("Both devices display a code", `${sasAlpha} / ${sasBravo}`);
    check("the two codes match", sasAlpha === sasBravo, "a man in the middle could not do this");

    // Bravo joins the same vault, and the first session pairs them.
    await bravo.store.metadata.saveVault({ id: vaultId, name: "Shared.kdbx", createdAt: new Date() });
    const first = await sync(alpha, bravo, vaultId, true);
    say("First sync, in pairing mode", `${bravo.name} received ${first.b.received.length} revision`);
    check(
      "keys were pinned on both sides",
      alpha.known.has(bravo.keyPair.deviceId) && bravo.known.has(alpha.keyPair.deviceId),
      "later sessions no longer need pairing mode"
    );

    await bravo.engine.fastForward(vaultId, root.id);
    const bravoWatcher = new VaultFileWatcher({
      vaultPath: bravoVaultPath,
      debounceMs: 150,
      onChange: async (bytes) => {
        await bravo.engine.recordLocalChange(vaultId, bytes);
      }
    });
    bravoWatcher.start();

    // ---- both devices edit while apart ---------------------------------
    await writeVaultFileAtomic({ vaultPath: alphaVaultPath, bytes: await addEntry(base, "Email") });
    await waitFor(
      async () => (await alpha.store.metadata.listRevisions(vaultId)).length === 2,
      "the watcher to notice Laptop's save"
    );
    say(`${alpha.name} added "Email" in KeePassXC`, "watcher recorded a revision");

    await writeVaultFileAtomic({ vaultPath: bravoVaultPath, bytes: await addEntry(base, "Router") });
    await waitFor(
      async () => (await bravo.store.metadata.listRevisions(vaultId)).length === 2,
      "the watcher to notice Desktop's save"
    );
    say(`${bravo.name} added "Router" while offline`, "watcher recorded a revision");

    // ---- reconnect ------------------------------------------------------
    const second = await sync(alpha, bravo, vaultId);
    say("They reconnect and sync", `${second.a.divergence.kind}`);
    check(
      "divergence was detected, not silently resolved",
      second.a.divergence.kind === "diverged",
      second.a.divergence.kind === "diverged"
        ? `merge base ${second.a.divergence.mergeBases[0]?.slice(0, 8)}`
        : ""
    );
    check(
      "each device pulled the other's branch",
      second.a.received.length === 1 && second.b.received.length === 1,
      "no vault bytes touched the signaling path"
    );

    const bravoVault = await bravo.store.metadata.getVault(vaultId);
    const bravoHead = bravoVault?.headRevisionId;
    const incoming = (await bravo.store.metadata.listRevisions(vaultId)).find(
      (revision) => revision.operation === "received" && revision.id !== root.id
    );
    if (bravoHead === undefined || incoming === undefined) {
      throw new Error("expected Desktop to hold both branches");
    }

    // ---- merge ----------------------------------------------------------
    const merged = await bravo.engine.merge({
      vaultId,
      baseRevisionId: bravoHead,
      incomingRevisionIds: [incoming.id],
      credentials: uniformCredentials(PASSWORD, 1)
    });
    if (merged.kind !== "merged") {
      throw new Error(`merge failed: ${merged.kind === "failed" ? merged.reason : merged.kind}`);
    }
    say(`${bravo.name} merged both branches`, `revision ${merged.revision.id.slice(0, 8)}`);

    const mergedTitles = await titlesIn(await bravo.engine.bytesOf(merged.revision.id));
    check(
      "the merge kept every entry",
      mergedTitles.join(",") === "Bank,Email,Router",
      mergedTitles.join(", ")
    );
    check(
      "the merge did not become active on its own",
      (await bravo.store.metadata.getVault(vaultId))?.headRevisionId === bravoHead,
      "promotion stays a deliberate act"
    );

    // ---- promote and write back ------------------------------------------
    await bravo.engine.promote(vaultId, merged.revision.id);
    await bravoWatcher.stop();
    const written = await writeVaultFileAtomic({
      vaultPath: bravoVaultPath,
      bytes: await bravo.engine.bytesOf(merged.revision.id)
    });
    say(`${bravo.name} promoted and wrote to disk`, written.kind);

    const onDisk = await titlesIn(await readVaultFile(bravoVaultPath));
    check(
      "the file KeePassXC opens now holds the merge",
      onDisk.join(",") === "Bank,Email,Router",
      bravoVaultPath
    );

    // ---- KeePassXC lock etiquette -----------------------------------------
    await writeFile(`${bravoVaultPath}.lock`, "");
    const refused = await writeVaultFileAtomic({
      vaultPath: bravoVaultPath,
      bytes: new Uint8Array([0])
    });
    check(
      "writes are refused while KeePassXC holds the vault",
      refused.kind === "refused-locked",
      "so it cannot save its copy back over the merge"
    );
    await rm(`${bravoVaultPath}.lock`);

    // ---- an unpaired device gets nothing ----------------------------------
    const stranger = await bootDevice("Someone else");
    await stranger.store.metadata.saveVault({ id: vaultId, name: "Shared.kdbx", createdAt: new Date() });
    let rejected = "";
    try {
      await sync(alpha, stranger, vaultId);
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error);
    }
    check("an unpaired device is refused", rejected.length > 0, rejected.slice(0, 60));
    stranger.store.close();
    await rm(stranger.root, { recursive: true, force: true });

    await alphaWatcher.stop();

    console.log();
    if (failures === 0) {
      console.log(ok(bold("  All checks passed.")));
      console.log(dim("  Everything above the transport works. WebRTC itself is exercised only"));
      console.log(dim("  by running two desktop apps — see README, 'Trying it'.\n"));
    } else {
      console.log(warn(bold(`  ${failures} check(s) failed.`)));
      process.exitCode = 1;
    }
  } finally {
    alpha.store.close();
    bravo.store.close();
    await rm(alpha.root, { recursive: true, force: true });
    await rm(bravo.root, { recursive: true, force: true });
    await rm(shared, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`\n[31mDemo failed:[0m ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});

export type { VaultId };

import { afterEach, describe, expect, it } from "vitest";

/**
 * The desktop layer, driven end to end.
 *
 * Everything below the app has its own tests, and `pnpm demo` exercises the
 * engine against real KDBX files. What had no coverage at all was
 * `DesktopServices` — the part that decides when a handshake pauses for a
 * human, when the file on disk is rewritten, and what happens when a device is
 * disconnected. That is the layer a person actually touches, so it is the
 * layer where a regression is felt.
 *
 * Two real service instances are wired to each other through their own IPC
 * hubs. That is the same seam the renderer bridges with WebRTC: everything
 * above it — handshake, authentication, transfer, conflict detection, write
 * back to disk — is the real code path, and only the wire is shortened.
 *
 * `safeStorage` is the one Electron API the main process needs; the test
 * runner aliases it to a stub rather than the whole layer being mocked out.
 */

const { DesktopServices } = await import("../apps/desktop/src/main/services.js");
const { startSignalingServer } = await import("../apps/signaling/src/index.js");
const { KdbxInterpreter } = await import("../packages/kdbx/src/index.js");
const kdbxweb = (await import("kdbxweb")).default;
const { argon2d, argon2i, argon2id } = await import("hash-wasm");

const { mkdtemp, readFile, writeFile, rm, stat } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { dirname, join } = await import("node:path");

type Services = InstanceType<typeof DesktopServices>;
type PeerFrame = import("../apps/desktop/src/shared/api.js").PeerFrame;

const PASSWORD = "correct horse battery staple";

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const options = {
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    parallelism,
    iterations,
    memorySize: memory,
    hashLength: length,
    outputType: "binary" as const
  };
  const hash =
    type === kdbxweb.CryptoEngine.Argon2TypeArgon2d
      ? await argon2d(options)
      : type === kdbxweb.CryptoEngine.Argon2TypeArgon2id
        ? await argon2id(options)
        : await argon2i(options);
  return new Uint8Array(hash).buffer;
});

async function makeVault(path: string, entries: readonly string[]): Promise<void> {
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
  const db = kdbxweb.Kdbx.create(credentials, "Shared");
  for (const title of entries) {
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", title);
    entry.fields.set("Password", kdbxweb.ProtectedValue.fromString(`${title}-secret`));
  }
  await writeFile(path, Buffer.from(await db.save()));
}

/**
 * Edit an existing vault, the way KeePassXC would.
 *
 * Not the same as writing a fresh one: `Kdbx.create` mints a new root group,
 * and two databases that never shared an ancestor cannot be merged — KeePass
 * rejects them with "default group is different". Both devices are always
 * editing descendants of one original file, so a test that fabricates two
 * unrelated vaults is testing a situation the app cannot get into.
 */
async function addEntry(path: string, title: string): Promise<void> {
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
  const db = await kdbxweb.Kdbx.load(
    new Uint8Array(await readFile(path)).buffer as ArrayBuffer,
    credentials
  );
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set("Title", title);
  entry.fields.set("Password", kdbxweb.ProtectedValue.fromString(`${title}-secret`));
  await writeFile(path, Buffer.from(await db.save()));
}

/** Open a vault and list its entry titles, to prove what actually survived. */
async function titlesIn(path: string): Promise<string[]> {
  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
  const db = await kdbxweb.Kdbx.load(
    new Uint8Array(await readFile(path)).buffer as ArrayBuffer,
    credentials
  );
  const titles: string[] = [];
  for (const group of db.groups) {
    for (const entry of group.allEntries()) {
      const title = entry.fields.get("Title");
      if (typeof title === "string") {
        titles.push(title);
      }
    }
  }
  return titles.sort();
}

const dirs: string[] = [];
async function scratch(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pv-${name}-`));
  dirs.push(dir);
  return dir;
}

interface Device {
  readonly services: Services;
  readonly appData: string;
  readonly vaultPath: string;
  /** Where this device's outbound frames go once it has been linked to a peer. */
  route: (frame: PeerFrame) => void;
}

async function startDevice(name: string, options: { withVault?: readonly string[] } = {}): Promise<Device> {
  const appData = await scratch(`${name}-data`);
  const vaultDir = await scratch(`${name}-vault`);
  const vaultPath = join(vaultDir, `${name}.kdbx`);

  // Filled in by link(); a device has nowhere to send until it has a peer.
  const device: { route: (frame: PeerFrame) => void } = { route: () => {} };

  const services = new DesktopServices({
    appDataDir: appData,
    defaultServerHost: "localhost:8787",
    emitPeerFrame: (frame) => device.route(frame),
    onSnapshotChanged: () => {},
    onSyncSuggested: () => {}
  });
  await services.start();

  if (options.withVault !== undefined) {
    await makeVault(vaultPath, options.withVault);
    await services.bindVault(vaultPath);
  }

  return {
    services,
    appData,
    vaultPath,
    get route() {
      return device.route;
    },
    set route(next: (frame: PeerFrame) => void) {
      device.route = next;
    }
  };
}

/**
 * Point two devices at each other.
 *
 * Each side's outbound frames become the other's inbound, relabelled with the
 * peer id that side knows the sender by — exactly what the renderer's WebRTC
 * bridge does, without the network.
 */
function link(a: Device, b: Device): void {
  // Delivered on a later tick so neither side re-enters the other's send path
  // synchronously, which no real transport does.
  a.route = (frame) =>
    queueMicrotask(() => b.services.peers.deliverInbound({ ...frame, peerId: "peer-a" }));
  b.route = (frame) =>
    queueMicrotask(() => a.services.peers.deliverInbound({ ...frame, peerId: "peer-b" }));
}

/** Run both sides of a session at once; a handshake needs both halves live. */
async function syncBoth(
  a: Device,
  b: Device,
  pairing = false
): Promise<[Awaited<ReturnType<Services["runSession"]>>, Awaited<ReturnType<Services["runSession"]>>]> {
  return Promise.all([
    a.services.runSession("peer-b", pairing),
    b.services.runSession("peer-a", pairing)
  ]);
}

/** Answer the six-digit prompt on both devices as soon as each appears. */
function confirmBothWhenAsked(a: Device, b: Device): () => void {
  const timer = setInterval(() => {
    for (const device of [a, b]) {
      device.services.answerVerification(true);
    }
  }, 5);
  return () => clearInterval(timer);
}

/**
 * Wait for something the other device does on its own schedule.
 *
 * A one-sided sync resolves when the *initiator* is finished; the device that
 * answered writes its file a moment later. Polling reflects that honestly —
 * asserting the instant the initiator returns tests a guarantee the design
 * never made.
 */
async function eventually(check: () => Promise<boolean>, withinMs = 4000): Promise<void> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`condition still false after ${withinMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

describe("connection", () => {
  it("pairs two devices and pins each other's key", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    const [left, right] = await syncBoth(laptop, desktop, true);
    stop();

    expect(left.kind).toBe("completed");
    expect(right.kind).toBe("completed");

    // Both sides now hold the other as a trusted device, which is what makes
    // the next session possible without pairing mode.
    expect((await laptop.services.snapshot()).pairedDevices).toHaveLength(1);
    expect((await desktop.services.snapshot()).pairedDevices).toHaveLength(1);

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("syncs again afterwards without pairing mode", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();

    // Pairing mode off: this only succeeds because the keys were pinned.
    const [again] = await syncBoth(laptop, desktop, false);
    expect(again.kind).toBe("completed");

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("remembers where to meet a paired device again", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    // A room has to exist before a rendezvous can be recorded against it.
    const server = await startSignalingServer(0);
    try {
      for (const device of [laptop, desktop]) {
        device.services.saveConnectionSettings({ serverHost: `localhost:${server.port}` });
      }
      const code = await laptop.services.createPairingCode();
      const accepted = await desktop.services.readPairingCode(code.code);
      expect("error" in accepted).toBe(false);

      const stop = confirmBothWhenAsked(laptop, desktop);
      await syncBoth(laptop, desktop, true);
      stop();

      const peer = (await laptop.services.snapshot()).pairedDevices[0];
      expect(peer).toBeDefined();
      // Without this the two devices can never find each other again and
      // every reconnect becomes a fresh pairing.
      expect(laptop.services.rendezvousFor(peer!.deviceId)).toBeDefined();
      expect(laptop.services.standingRendezvous()?.roomId).toBe(code.roomId);
    } finally {
      await server.close();
      await laptop.services.stop();
      await desktop.services.stop();
    }
  });

  it("accepts a server address however it was pasted", async () => {
    const device = await startDevice("solo");
    for (const pasted of [
      "sync.example.org",
      "https://sync.example.org",
      "https://sync.example.org/health"
    ]) {
      expect(device.services.saveConnectionSettings({ serverHost: pasted }).serverHost).toBe(
        "sync.example.org"
      );
    }
    expect(() => device.services.saveConnectionSettings({ serverHost: "not a host" })).toThrow(
      /server address/u
    );
    await device.services.stop();
  });
});

describe("syncing", () => {
  it("carries a vault to a device that has none", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank", "Email"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    const [, received] = await syncBoth(laptop, desktop, true);
    stop();

    expect(received.kind).toBe("completed");
    const snapshot = await desktop.services.snapshot();
    // It has the vault but nowhere to put it yet, which is the state the
    // interface reports as "Almost there".
    expect(snapshot.state.kind).toBe("needs-file");
    expect(snapshot.versions.length).toBeGreaterThan(0);

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("notices when both devices changed the vault", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();

    const landed = await desktop.services.saveVaultAs(desktop.vaultPath);
    expect(landed.kind).toBe("written");

    // Each device edits its own copy while apart.
    await addEntry(laptop.vaultPath, "Only-on-laptop");
    await addEntry(desktop.vaultPath, "Only-on-desktop");
    await laptop.services.recordFileNow();
    await desktop.services.recordFileNow();

    const [outcome] = await syncBoth(laptop, desktop, false);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      // Detected, never silently resolved: picking a winner without asking is
      // how one device's changes disappear.
      expect(outcome.divergence).toBe("diverged");
    }
    expect((await laptop.services.snapshot()).conflicts).toHaveLength(1);

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("combines both sides and keeps every entry", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();
    await desktop.services.saveVaultAs(desktop.vaultPath);

    await addEntry(laptop.vaultPath, "Only-on-laptop");
    await addEntry(desktop.vaultPath, "Only-on-desktop");
    await laptop.services.recordFileNow();
    await desktop.services.recordFileNow();
    await syncBoth(laptop, desktop, false);

    const fork = (await laptop.services.snapshot()).versions.find((v) => v.canCombine);
    expect(fork).toBeDefined();

    const merged = await laptop.services.combineAndUse({
      otherVersionId: fork!.id,
      password: PASSWORD
    });
    expect(merged, JSON.stringify(merged)).toMatchObject({ kind: "merged" });

    // The whole promise of combining: nothing from either side is dropped.
    expect(await titlesIn(laptop.vaultPath)).toEqual([
      "Bank",
      "Only-on-desktop",
      "Only-on-laptop"
    ]);

    await laptop.services.stop();
    await desktop.services.stop();
  });
});

describe("saving to disk", () => {
  it("writes the current version to the file without being asked", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();
    await desktop.services.saveVaultAs(desktop.vaultPath);

    // A change on one device should reach the other's file with nobody
    // pressing anything.
    await addEntry(laptop.vaultPath, "Added-later");
    await laptop.services.recordFileNow();
    await syncBoth(laptop, desktop, false);

    expect(await titlesIn(desktop.vaultPath)).toEqual(["Added-later", "Bank"]);

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("leaves the file alone when it already matches", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const before = await stat(laptop.vaultPath);

    // Repeated materialisation must be free; rewriting identical bytes churns
    // the file KeePassXC is watching and invites a pointless conflict.
    await laptop.services.applyPendingUpdate();
    await laptop.services.applyPendingUpdate();

    const after = await stat(laptop.vaultPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    await laptop.services.stop();
  });

  it("refuses to overwrite the vault while KeePassXC holds it open", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    await writeFile(`${laptop.vaultPath}.lock`, "held");

    const outcome = await laptop.services.applyPendingUpdate();
    // Writing underneath KeePassXC is how the app would destroy the very file
    // it exists to protect.
    expect(outcome.kind).toBe("refused-locked");

    await rm(`${laptop.vaultPath}.lock`);
    await laptop.services.stop();
  });

  it("keeps every version, so restoring an older one loses nothing", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    await addEntry(laptop.vaultPath, "Second");
    await laptop.services.recordFileNow();

    const versions = (await laptop.services.snapshot()).versions;
    expect(versions.length).toBe(2);

    const oldest = versions[versions.length - 1]!;
    await laptop.services.promote(oldest.id);

    // Restored on disk, and the newer version is still in the history.
    expect(await titlesIn(laptop.vaultPath)).toEqual(["Bank"]);
    expect((await laptop.services.snapshot()).versions.length).toBe(2);

    await laptop.services.stop();
  });
});

describe("security", () => {
  it("refuses a device that was never paired", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const stranger = await startDevice("stranger", { withVault: ["Other"] });
    link(laptop, stranger);

    // Not pairing mode: neither has ever seen the other.
    const [outcome] = await syncBoth(laptop, stranger, false);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      // The message a person reads, not the protocol's own words: "revoked"
      // and "not paired" name internal states and appear identically on both
      // devices, telling neither which of them refused.
      expect(outcome.reason).not.toMatch(/peer rejected|peer reported|unauthorized/u);
      expect(outcome.reason).toMatch(/not set up on this one|does not have this one set up/u);
      // And it points at the screen where the next step actually is.
      expect(outcome.reason).toMatch(/Devices|that device/u);
    }

    await laptop.services.stop();
    await stranger.services.stop();
  });

  it("shares nothing when the six digits are refused", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    // Say no on one side, as a person would on seeing different numbers.
    const timer = setInterval(() => {
      desktop.services.answerVerification(false);
      laptop.services.answerVerification(false);
    }, 5);
    const [outcome] = await syncBoth(laptop, desktop, true);
    clearInterval(timer);

    expect(outcome.kind).toBe("failed");
    const snapshot = await desktop.services.snapshot();
    // No key pinned and no vault: refusing has to cost nothing to undo.
    expect(snapshot.pairedDevices).toHaveLength(0);
    expect(snapshot.versions).toHaveLength(0);

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("refuses a device after it is disconnected, and works again once reconnected", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();

    const peer = (await laptop.services.snapshot()).pairedDevices[0]!;
    await laptop.services.disconnectDevice(peer.deviceId);

    const [refused] = await syncBoth(laptop, desktop, false);
    expect(refused.kind).toBe("failed");

    // Reversible by design: the pinned key was never discarded.
    await laptop.services.reconnectDevice(peer.deviceId);
    const [allowed] = await syncBoth(laptop, desktop, false);
    expect(allowed.kind).toBe("completed");

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("forgets a device completely when asked", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();

    const peer = (await laptop.services.snapshot()).pairedDevices[0]!;
    await laptop.services.forgetDevice(peer.deviceId);

    const snapshot = await laptop.services.snapshot();
    expect(snapshot.pairedDevices).toHaveLength(0);
    // The rendezvous goes too, or the device would still be met in the room
    // it was forgotten from.
    expect(laptop.services.rendezvousFor(peer.deviceId)).toBeUndefined();

    await laptop.services.stop();
  });

  it("never writes the master password anywhere", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();
    await desktop.services.saveVaultAs(desktop.vaultPath);

    await addEntry(laptop.vaultPath, "L");
    await addEntry(desktop.vaultPath, "D");
    await laptop.services.recordFileNow();
    await desktop.services.recordFileNow();
    await syncBoth(laptop, desktop, false);

    const fork = (await laptop.services.snapshot()).versions.find((v) => v.canCombine)!;
    // A merge is the only operation that ever sees the password.
    await laptop.services.combineAndUse({ otherVersionId: fork.id, password: PASSWORD });

    const { readdir } = await import("node:fs/promises");
    const walk = async (dir: string): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        found.push(...(entry.isDirectory() ? await walk(path) : [path]));
      }
      return found;
    };

    for (const file of await walk(laptop.appData)) {
      const bytes = await readFile(file);
      expect(
        bytes.includes(Buffer.from(PASSWORD, "utf8")),
        `${file} contains the master password`
      ).toBe(false);
    }

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("keeps stored revisions encrypted, not plaintext entry names", async () => {
    const laptop = await startDevice("laptop", { withVault: ["MySecretBankLogin"] });

    const { readdir } = await import("node:fs/promises");
    const blobDir = join(laptop.appData, "blobs");
    const walk = async (dir: string): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        found.push(...(entry.isDirectory() ? await walk(path) : [path]));
      }
      return found;
    };

    const blobs = await walk(blobDir);
    expect(blobs.length).toBeGreaterThan(0);
    for (const blob of blobs) {
      const bytes = await readFile(blob);
      // The whole design rests on this: what is stored is the vault as
      // KeePassXC encrypted it, and an entry title must not be readable in it.
      expect(bytes.includes(Buffer.from("MySecretBankLogin", "utf8"))).toBe(false);
    }

    await laptop.services.stop();
  });

  it("keeps the device private key readable only by its owner", async () => {
    const laptop = await startDevice("laptop");
    const key = await stat(join(laptop.appData, "device-identity.json"));
    // 0o600. This test runs with no keychain available, so the file is the
    // only thing protecting the key.
    expect(key.mode & 0o777).toBe(0o600);
    await laptop.services.stop();
  });

  it("shows both devices the same six digits, and a different pair a different number", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    const stranger = await startDevice("stranger");

    const keyOf = async (d: Device): Promise<string> => (await d.services.snapshot()).device.publicKeyBase64;

    const asLaptopSees = laptop.services.sasFor(await keyOf(desktop));
    const asDesktopSees = desktop.services.sasFor(await keyOf(laptop));
    // Both sides compute it from the same two keys, so they must agree — that
    // agreement is the entire signal a person is asked to check.
    expect(asLaptopSees).toBe(asDesktopSees);

    // A machine in the middle presents a different key, and cannot make the
    // two screens match.
    expect(laptop.services.sasFor(await keyOf(stranger))).not.toBe(asLaptopSees);

    await laptop.services.stop();
    await desktop.services.stop();
    await stranger.services.stop();
  });
  it("makes an altered pairing link show a different number, and rejects a malformed one", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");

    const server = await startSignalingServer(0);
    try {
      laptop.services.saveConnectionSettings({ serverHost: `localhost:${server.port}` });
      desktop.services.saveConnectionSettings({ serverHost: `localhost:${server.port}` });
      const code = await laptop.services.createPairingCode();

      const honest = await desktop.services.readPairingCode(code.code);
      expect("error" in honest).toBe(false);

      // Substituting a well-formed key of the right length is accepted, and
      // should be: the offer is public and unauthenticated, which is the whole
      // reason the six digits exist. What must not happen is the two screens
      // agreeing anyway.
      const interloper = await startDevice("interloper");
      const interloperKey = (await interloper.services.snapshot()).device.publicKeyBase64;
      const tampered = code.code.replace(/k=[^&]+/u, `k=${encodeURIComponent(interloperKey)}`);

      const swapped = await desktop.services.readPairingCode(tampered);
      expect("error" in swapped).toBe(false);
      if (!("error" in swapped) && !("error" in honest)) {
        // Laptop is still showing the number for its own key, so the two
        // devices disagree and the person is asked to refuse.
        expect(swapped.shortAuthenticationString).not.toBe(honest.shortAuthenticationString);
      }
      await interloper.services.stop();

      // A key that is not a key at all never gets as far as a human.
      const malformed = code.code.replace(/k=[^&]+/u, "k=tooshort");
      expect("error" in (await desktop.services.readPairingCode(malformed))).toBe(true);
    } finally {
      await server.close();
      await laptop.services.stop();
      await desktop.services.stop();
    }
  });

  it("keeps the other device's version after choosing to keep this one", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();
    await desktop.services.saveVaultAs(desktop.vaultPath);

    await addEntry(laptop.vaultPath, "Only-on-laptop");
    await addEntry(desktop.vaultPath, "Only-on-desktop");
    await laptop.services.recordFileNow();
    await desktop.services.recordFileNow();
    await syncBoth(laptop, desktop, false);

    const before = (await laptop.services.snapshot()).versions.length;
    const conflict = (await laptop.services.snapshot()).conflicts[0]!;
    await laptop.services.resolveConflict(conflict.id, "keep-current");

    const after = await laptop.services.snapshot();
    // Choosing a side settles which one is in use. It must never delete the
    // other, or the decision becomes unrecoverable.
    expect(after.versions.length).toBe(before);
    expect(after.conflicts).toHaveLength(0);

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("refuses to sync two vaults that were imported separately", async () => {
    // The mistake is easy to make: set up the file on both devices instead of
    // sharing it from one. They are unrelated vaults that happen to look
    // alike, and merging them would be meaningless.
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop", { withVault: ["Bank"] });
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    const [outcome] = await syncBoth(laptop, desktop, true);
    stop();

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      // Both devices detect this themselves and so both show it at once. Naming
      // the two files is what keeps the advice from being "you go first" on
      // both screens: each person can see which of the two is theirs.
      expect(outcome.reason).toContain("laptop.kdbx");
      expect(outcome.reason).toContain("desktop.kdbx");
      // And the way out is an action in the app, not advice to start over.
      expect(outcome.reason).toMatch(/Stop tracking it/u);
    }

    await laptop.services.stop();
    await desktop.services.stop();
  });
});

describe("changing which file is tracked", () => {
  it("replaces the tracked file, and still has it after a restart", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const first = (await laptop.services.snapshot()).vault?.id;

    const second = join(dirname(laptop.vaultPath), "second.kdbx");
    await makeVault(second, ["Email"]);
    await laptop.services.bindVault(second);

    const after = await laptop.services.snapshot();
    expect(after.vault?.kdbxPath).toBe(second);
    expect(after.vault?.id).not.toBe(first);
    await laptop.services.stop();

    // The choice used to live only in memory: whichever vault row came back
    // first won on the next launch, so switching quietly undid itself.
    const revived = new DesktopServices({
      appDataDir: laptop.appData,
      defaultServerHost: "localhost:8787",
      emitPeerFrame: () => {},
      onSnapshotChanged: () => {},
      onSyncSuggested: () => {}
    });
    await revived.start();
    expect((await revived.snapshot()).vault?.kdbxPath).toBe(second);
    await revived.stop();
  });

  it("goes back to a file it already tracks instead of importing it twice", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const original = (await laptop.services.snapshot()).vault?.id;

    const second = join(dirname(laptop.vaultPath), "second.kdbx");
    await makeVault(second, ["Email"]);
    await laptop.services.bindVault(second);
    await laptop.services.bindVault(laptop.vaultPath);

    const back = await laptop.services.snapshot();
    // A second import would mint a new id over identical bytes, forking the
    // history against itself with no shared ancestor to reconcile it.
    expect(back.vault?.id).toBe(original);
    expect(back.versions).toHaveLength(1);

    await laptop.services.stop();
  });

  it("lets both devices move onto one device's file", async () => {
    // The mistake the app previously had no way out of: a file set up
    // separately on each device.
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop", { withVault: ["Email"] });
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    const [refused] = await syncBoth(laptop, desktop, true);
    stop();
    expect(refused.kind).toBe("failed");

    // The remedy the message now names. Pairing already succeeded — the two
    // vaults are what could not be reconciled — so this session needs no
    // pairing mode.
    await desktop.services.stopTrackingVault();
    expect((await desktop.services.snapshot()).state.kind).toBe("needs-setup");
    // The file itself is left alone; only the tracking stopped.
    expect((await stat(desktop.vaultPath)).size).toBeGreaterThan(0);

    const [left, right] = await syncBoth(laptop, desktop, false);
    expect(left.kind).toBe("completed");
    expect(right.kind).toBe("completed");

    const joined = await desktop.services.snapshot();
    expect(joined.vault?.id).toBe((await laptop.services.snapshot()).vault?.id);
    expect(joined.state.kind).toBe("needs-file");

    await laptop.services.stop();
    await desktop.services.stop();
  });
});

describe("knowing whether the other device is there", () => {
  it("reports a device online only once a live channel is tied to it", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();

    // Paired, but nothing has said a channel is open, so nothing is claimed.
    expect((await laptop.services.snapshot()).pairedDevices[0]?.online).toBe(false);

    // A channel alone is not enough: a signaling peer id is a random UUID that
    // says nothing about who is behind it until the handshake proves it.
    laptop.services.peerOpened("peer-b");
    expect((await laptop.services.snapshot()).pairedDevices[0]?.online).toBe(false);

    await syncBoth(laptop, desktop, false);
    expect((await laptop.services.snapshot()).pairedDevices[0]?.online).toBe(true);

    // And presence must outlive the session: closeLink runs at the end of every
    // sync, so only the channel closing may take a device offline.
    expect((await laptop.services.snapshot()).pairedDevices[0]?.online).toBe(true);
    laptop.services.peerGone("peer-b");
    expect((await laptop.services.snapshot()).pairedDevices[0]?.online).toBe(false);

    await laptop.services.stop();
    await desktop.services.stop();
  });
});

/**
 * A sync has two halves, and either device may be the one to start.
 *
 * This is the case that was broken: frames for a peer with no session running
 * were dropped, so the device that started got no reply and gave up thirty
 * seconds later complaining about a missing hello. It looked like an idle
 * timeout and needed both windows reloaded to clear.
 */
describe("either device can start a sync", () => {
  it("answers a peer that starts one while this side is idle", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();

    // Only one side asks for a session now. The other is doing nothing at all,
    // exactly as it would be while sitting on the Home tab.
    const alone = await laptop.services.runSession("peer-b", false);
    expect(alone.kind, JSON.stringify(alone)).toBe("completed");

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("carries a saved change to an idle device without anyone pressing sync", async () => {
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const desktop = await startDevice("desktop");
    link(laptop, desktop);

    const stop = confirmBothWhenAsked(laptop, desktop);
    await syncBoth(laptop, desktop, true);
    stop();
    await desktop.services.saveVaultAs(desktop.vaultPath);

    await addEntry(laptop.vaultPath, "Added-while-idle");
    await laptop.services.recordFileNow();

    // One-sided again: the whole point of auto-sync is that the other device
    // is not participating in the decision.
    const pushed = await laptop.services.runSession("peer-b", false);
    expect(pushed.kind).toBe("completed");

    await eventually(async () => {
      const titles = await titlesIn(desktop.vaultPath);
      return titles.includes("Added-while-idle");
    });
    expect(await titlesIn(desktop.vaultPath)).toEqual(["Added-while-idle", "Bank"]);

    await laptop.services.stop();
    await desktop.services.stop();
  });

  it("does not let an idle device pin an unknown key", async () => {
    // The responder decides its own pairing mode. If answering a stranger
    // implied consent to pin them, anyone who reached the rendezvous could
    // pair themselves without a single digit being compared.
    const laptop = await startDevice("laptop", { withVault: ["Bank"] });
    const stranger = await startDevice("stranger", { withVault: ["Other"] });
    link(laptop, stranger);

    // The stranger is pairing, so its own side will stop and ask a human about
    // the six digits. Answering no is what its user would do on seeing a
    // number that matches nothing.
    const running = stranger.services.runSession("peer-a", true);
    const declining = setInterval(() => stranger.services.answerVerification(false), 5);
    const outcome = await running;
    clearInterval(declining);

    expect(outcome.kind).toBe("failed");
    // The property under test: the device that merely *answered* never pinned
    // anything, whatever the initiator was hoping for.
    expect((await laptop.services.snapshot()).pairedDevices).toHaveLength(0);

    await laptop.services.stop();
    await stranger.services.stop();
  });
});

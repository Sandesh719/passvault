import {
  brand,
  classifyDivergence,
  cryptoIdGenerator,
  formatQualifiedShortCode,
  httpUrlFor,
  normalizeServerHost,
  openConflict,
  parseShortCode,
  recordConflictDecision,
  signalUrlFor,
  systemClock,
  type Conflict,
  type ConflictId,
  type DeviceId,
  type ParsedShortCode,
  type RevisionId,
  type VaultId
} from "@passvault/core";
import {
  createAuthenticator,
  decodePairingOffer,
  encodePairingOffer,
  fromBase64,
  shortAuthenticationString,
  toBase64,
  type TrustStore
} from "@passvault/identity";
import { KdbxInterpreter, uniformCredentials, type KdbxCredentialSet } from "@passvault/kdbx";
import {
  VaultFileWatcher,
  isVaultLocked,
  openLocalStore,
  readVaultFile,
  writeVaultFileAtomic,
  type LocalStore
} from "@passvault/storage-node";
import { SyncEngine, SyncSession } from "@passvault/sync";
import type {
  AcceptedPairing,
  AppSnapshot,
  IceServer,
  MergeOutcomeSummary,
  PairingCode,
  SyncOutcome,
  WriteBackOutcome
} from "../shared/api.js";
import { IpcPeerLinkHub } from "./ipcPeerLink.js";
import { loadOrCreateIdentity, type LoadedIdentity } from "./identityStore.js";
import { SettingsStore, type ConnectionSettings } from "./settings.js";
import { createSqliteTrustStore } from "./sqliteTrustStore.js";

const MAX_ACTIVITY = 200;

export interface Rendezvous {
  readonly roomId: string;
  readonly inviteToken: string;
  readonly signalUrl: string;
}

export interface ServicesDeps {
  readonly appDataDir: string;
  /**
   * Where to meet peers until the user says otherwise.
   *
   * A default, not a constant: two devices in different places have to be
   * pointed at a server they both reach, and that is theirs to choose.
   */
  readonly defaultServerHost: string;
  readonly emitPeerFrame: (frame: import("../shared/api.js").PeerFrame) => void;
  readonly onSnapshotChanged: () => void;
  /** Ask the window to sync now, because this device just changed. */
  readonly onSyncSuggested: () => void;
}

/**
 * Everything the main process owns, assembled once.
 *
 * The renderer never touches any of it directly — it has no filesystem, no
 * database handle, and no access to the device private key. That is the point
 * of the process split, not an incidental consequence of it.
 */
export class DesktopServices {
  private store!: LocalStore;
  private identity!: LoadedIdentity;
  private trust!: TrustStore;
  private engine!: SyncEngine<KdbxCredentialSet>;
  private watcher: VaultFileWatcher | undefined;
  private vaultId: VaultId | undefined;
  private readonly activity: string[] = [];
  /** One session per peer at a time; a second would fight the first for the link. */
  private readonly sessionsInFlight = new Set<string>();
  /** The room this device is currently sitting in, pending a peer identifying itself. */
  private pendingRendezvous: Rendezvous | undefined;
  /** Set when the file could not be updated because KeePassXC held it open. */
  private updateHeldBack = false;
  /** A handshake paused mid-flight, waiting for a person to compare six digits. */
  private verification:
    | {
        readonly deviceId: DeviceId;
        readonly peerName: string;
        readonly code: string;
        readonly resolve: (confirmed: boolean) => void;
        readonly timer: NodeJS.Timeout;
      }
    | undefined;
  private unlockTimer: NodeJS.Timeout | undefined;
  public readonly peers: IpcPeerLinkHub;
  private settings!: SettingsStore;

  public constructor(private readonly deps: ServicesDeps) {
    this.peers = new IpcPeerLinkHub(deps.emitPeerFrame);
    // A sync has two halves and either device may start one. Without this the
    // initiator waits for a hello that the idle side never sends.
    this.peers.onPeerInitiated = (peerId) => {
      if (this.sessionsInFlight.has(peerId)) {
        return;
      }
      void this.runSession(peerId, this.pairingUnderway());
    };
  }

  /**
   * Is a pairing in progress?
   *
   * Only matters for a session this side did not start: pinning an unknown
   * device's key is allowed while someone is actively pairing and never
   * otherwise. Set when a code is created or read, cleared once a session with
   * a pinned key succeeds.
   */
  private pairingStartedAt: number | undefined;

  private pairingUnderway(): boolean {
    // Bounded by the same five minutes the verification prompt allows, so an
    // abandoned pairing cannot leave the door open.
    return (
      this.pairingStartedAt !== undefined && Date.now() - this.pairingStartedAt < 5 * 60_000
    );
  }

  public async start(): Promise<void> {
    this.store = await openLocalStore(this.deps.appDataDir);
    this.identity = await loadOrCreateIdentity(this.deps.appDataDir);
    this.trust = createSqliteTrustStore(this.store.metadata.connection);
    this.settings = new SettingsStore(this.store.metadata.connection, this.deps.defaultServerHost);
    this.engine = new SyncEngine<KdbxCredentialSet>({
      metadata: this.store.metadata,
      blobs: this.store.blobs,
      hash: this.store.hash,
      interpreter: new KdbxInterpreter(),
      clock: systemClock,
      ids: cryptoIdGenerator,
      deviceId: this.identity.keyPair.deviceId
    });

    if (this.identity.atRestUnprotected) {
      this.log("This system has no keychain available, so the device key is stored unencrypted.");
    }

    const vaults = await this.store.metadata.listVaults();
    const existing = vaults[0];
    if (existing !== undefined) {
      this.vaultId = existing.id;
      if (existing.kdbxPath !== undefined) {
        await this.startWatching(existing.kdbxPath);
      }
      this.log(`Reopened ${existing.name}.`);
    } else {
      this.log("Choose a .kdbx vault to begin.");
    }
  }

  public async stop(): Promise<void> {
    await this.watcher?.stop();
    this.peers.closeAll();
    this.store?.close();
  }

  // ---- vault ---------------------------------------------------------

  public async bindVault(kdbxPath: string): Promise<void> {
    const bytes = await readVaultFile(kdbxPath);
    const name = kdbxPath.split("/").pop() ?? "vault.kdbx";

    const { vault } = await this.engine.importVault({ name, bytes, kdbxPath });
    this.vaultId = vault.id;
    await this.startWatching(kdbxPath);
    this.log(`Tracking ${name}. Its current contents are the first revision.`);
    this.deps.onSnapshotChanged();
  }

  /**
   * Read the vault file now and record it if it changed.
   *
   * The watcher normally does this, after a debounce. This is the same work
   * without the wait: useful when a change must be known to have landed before
   * the next step — a test, or a future "check for changes now" action — and
   * harmless otherwise, because recording an unchanged file is a no-op.
   */
  public async recordFileNow(): Promise<"recorded" | "unchanged" | "no-vault"> {
    const vaultId = this.vaultId;
    if (vaultId === undefined) {
      return "no-vault";
    }
    const vault = await this.store.metadata.getVault(vaultId);
    if (vault?.kdbxPath === undefined) {
      return "no-vault";
    }

    const result = await this.engine.recordLocalChange(vaultId, await readVaultFile(vault.kdbxPath));
    if (result.kind !== "recorded") {
      return "unchanged";
    }
    this.clearHeldBackUpdate();
    this.log("You saved changes in KeePassXC.");
    this.deps.onSnapshotChanged();
    this.deps.onSyncSuggested();
    return "recorded";
  }

  private async startWatching(kdbxPath: string): Promise<void> {
    await this.watcher?.stop();
    this.watcher = new VaultFileWatcher({
      vaultPath: kdbxPath,
      onChange: async (bytes) => {
        const vaultId = this.vaultId;
        if (vaultId === undefined) {
          return;
        }
        const result = await this.engine.recordLocalChange(vaultId, bytes);
        if (result.kind === "recorded") {
          this.clearHeldBackUpdate();
          this.log("You saved changes in KeePassXC.");
          this.deps.onSnapshotChanged();
          // Push it out without being asked. Waiting for a button is how the
          // two devices end up quietly out of step.
          this.deps.onSyncSuggested();
        }
      },
      onError: (error) => this.log(`Watching the vault failed: ${error.message}`)
    });
    this.watcher.start();
  }

  /**
   * Make the file on disk match the current version.
   *
   * Called after anything that moves the current version — a sync, a restore,
   * a combine. Keeping the file in step is the app's job, not a button the user
   * has to remember to press, and forgetting it is how two devices silently
   * drift apart while both claim to be up to date.
   *
   * Does nothing when the file already matches, so repeated calls are free.
   */
  private async materializeCurrentVersion(): Promise<void> {
    const vaultId = this.vaultId;
    if (vaultId === undefined) {
      return;
    }
    const vault = await this.store.metadata.getVault(vaultId);
    if (vault?.kdbxPath === undefined || vault.headRevisionId === undefined) {
      return;
    }
    const head = await this.store.metadata.getRevision(vault.headRevisionId);
    if (head === undefined) {
      return;
    }

    try {
      const onDisk = await readVaultFile(vault.kdbxPath);
      if ((await this.store.hash.sha256(onDisk)) === head.hash) {
        this.clearHeldBackUpdate();
        return;
      }
    } catch {
      // Missing file simply needs writing.
    }

    if (await isVaultLocked(vault.kdbxPath)) {
      if (!this.updateHeldBack) {
        this.updateHeldBack = true;
        this.log("KeePassXC has the file open. It will update as soon as you close it.");
        this.deps.onSnapshotChanged();
      }
      this.watchForUnlock();
      return;
    }

    await writeVaultFileAtomic({ vaultPath: vault.kdbxPath, bytes: await this.engine.bytesOf(head.id) });
    this.clearHeldBackUpdate();
    this.log("Updated the password file on this device.");
    this.deps.onSnapshotChanged();
  }

  /** Poll only while an update is waiting; the watcher does not see the lock file. */
  private watchForUnlock(): void {
    if (this.unlockTimer !== undefined) {
      return;
    }
    this.unlockTimer = setInterval(() => {
      void this.materializeCurrentVersion();
    }, 2000);
  }

  private clearHeldBackUpdate(): void {
    this.updateHeldBack = false;
    if (this.unlockTimer !== undefined) {
      clearInterval(this.unlockTimer);
      this.unlockTimer = undefined;
    }
  }

  public async applyPendingUpdate(): Promise<WriteBackOutcome> {
    const vaultId = this.vaultId;
    const vault = vaultId === undefined ? undefined : await this.store.metadata.getVault(vaultId);
    if (vault?.kdbxPath === undefined) {
      return { kind: "failed", reason: "No password file is set up on this device." };
    }
    if (await isVaultLocked(vault.kdbxPath)) {
      return {
        kind: "refused-locked",
        reason: "KeePassXC still has the file open. Close it and try again."
      };
    }
    await this.materializeCurrentVersion();
    return { kind: "written", path: vault.kdbxPath };
  }

  public async writeBack(revisionId: string, ignoreLock: boolean): Promise<WriteBackOutcome> {
    const vaultId = this.vaultId;
    if (vaultId === undefined) {
      return { kind: "failed", reason: "No vault is being tracked." };
    }
    const vault = await this.store.metadata.getVault(vaultId);
    if (vault?.kdbxPath === undefined) {
      return { kind: "failed", reason: "This vault is not bound to a file on disk." };
    }

    try {
      const bytes = await this.engine.bytesOf(brand<string, "RevisionId">(revisionId));
      const outcome = await writeVaultFileAtomic({ vaultPath: vault.kdbxPath, bytes, ignoreLock });
      if (outcome.kind === "refused-locked") {
        this.log("Refused to write: KeePassXC still has the vault open.");
        return outcome;
      }
      this.log(`Wrote revision ${short(revisionId)} to ${vault.kdbxPath}.`);
      this.deps.onSnapshotChanged();
      return { kind: "written", path: vault.kdbxPath };
    } catch (error) {
      return { kind: "failed", reason: messageOf(error) };
    }
  }

  /**
   * Give a vault that arrived from a peer a home on this disk.
   *
   * A joined vault exists in the history before it exists as a file, so this is
   * the step that hands it to KeePassXC.
   */
  public async saveVaultAs(kdbxPath: string): Promise<WriteBackOutcome> {
    const vaultId = this.requireVaultId();
    const vault = await this.store.metadata.getVault(vaultId);
    if (vault?.headRevisionId === undefined) {
      return { kind: "failed", reason: "This vault has no revision to write yet." };
    }
    try {
      const bytes = await this.engine.bytesOf(vault.headRevisionId);
      // A brand-new path cannot be locked by KeePassXC, and the user just
      // picked it, so there is nothing to defer to here.
      await writeVaultFileAtomic({ vaultPath: kdbxPath, bytes, ignoreLock: true });
      await this.engine.bindVaultToFile(vaultId, kdbxPath);
      await this.startWatching(kdbxPath);
      this.log(`Saved your passwords to ${kdbxPath}. Open that file in KeePassXC.`);
      this.deps.onSnapshotChanged();
      return { kind: "written", path: kdbxPath };
    } catch (error) {
      return { kind: "failed", reason: messageOf(error) };
    }
  }

  public async promote(revisionId: string): Promise<void> {
    const vaultId = this.requireVaultId();
    await this.engine.promote(vaultId, brand<string, "RevisionId">(revisionId));
    this.log("Put an earlier version back in use.");
    await this.materializeCurrentVersion();
    this.deps.onSnapshotChanged();
    this.deps.onSyncSuggested();
  }

  // ---- where this device meets peers ---------------------------------

  private backendUrl(): string {
    return httpUrlFor(this.settings.get().serverHost);
  }

  private signalUrl(): string {
    return signalUrlFor(this.settings.get().serverHost);
  }

  public connectionSettings(): ConnectionSettings {
    return this.settings.get();
  }

  public iceServers(): IceServer[] {
    return this.settings.iceServers();
  }

  public saveConnectionSettings(next: ConnectionSettings): ConnectionSettings {
    const saved = this.settings.save(next);
    this.log(`Now meeting other devices through ${saved.serverHost}.`);
    this.deps.onSnapshotChanged();
    return saved;
  }

  /**
   * Check a server before trusting it with a pairing attempt.
   *
   * Pointing two devices at the same server is the one setup step that has to
   * be right, and a wrong address otherwise shows up much later as a code that
   * "is not valid" — which reads like a typo in the code, not in the server.
   */
  public async testConnectionServer(raw: string): Promise<{ ok: boolean; detail: string }> {
    const host = normalizeServerHost(raw);
    if (host === undefined) {
      return {
        ok: false,
        detail: `Could not read "${raw.trim()}" as a server address. It should look like sync.example.org.`
      };
    }
    try {
      const response = await fetch(`${httpUrlFor(host)}/health`, {
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        return { ok: false, detail: `${host} answered, but with an error (${response.status}).` };
      }
      const body = (await response.json()) as { service?: string };
      return body.service === "passvault-signaling"
        ? { ok: true, detail: `${host} is reachable and is a PassVault server.` }
        : { ok: false, detail: `Something answered at ${host}, but it is not a PassVault server.` };
    } catch {
      return {
        ok: false,
        detail: `Could not reach ${host}. Check the address, and that it is running.`
      };
    }
  }

  // ---- pairing -------------------------------------------------------

  public async createPairingCode(): Promise<PairingCode> {
    const response = await fetch(`${this.backendUrl()}/rooms`, { method: "POST" });
    if (!response.ok) {
      throw new Error(`The signaling server refused to create a room (${response.status}).`);
    }
    const room = (await response.json()) as { roomId: string; inviteToken: string };

    const link = encodePairingOffer({
      deviceId: this.identity.keyPair.deviceId,
      publicKey: this.identity.keyPair.publicKey,
      name: this.identity.name,
      roomId: room.roomId,
      inviteToken: room.inviteToken,
      signalUrl: this.signalUrl()
    });

    this.pendingRendezvous = {
      roomId: room.roomId,
      inviteToken: room.inviteToken,
      signalUrl: this.signalUrl()
    };
    this.pairingStartedAt = Date.now();
    const short = await this.issueShortCode(link);
    this.log(
      short === undefined
        ? "Ready to connect. Copy the link to your other device."
        : `Ready to connect. Type ${short.shortCode} on your other device.`
    );
    return {
      code: link,
      roomId: room.roomId,
      inviteToken: room.inviteToken,
      signalUrl: this.signalUrl(),
      serverHost: this.settings.get().serverHost,
      ...(short ?? {})
    };
  }

  /**
   * Trade the pairing link for something a person can retype.
   *
   * Best effort on purpose: an older signaling server simply does not offer
   * this, and pairing by link still works. Losing the convenience should not
   * mean losing the feature.
   */
  private async issueShortCode(link: string): Promise<
    | {
        shortCode: string;
        shortCodeQualified: string;
        shortCodeExpiresAt: string;
      }
    | undefined
  > {
    try {
      const response = await fetch(`${this.backendUrl()}/pairing-codes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer: link })
      });
      if (!response.ok) {
        return undefined;
      }
      const issued = (await response.json()) as { code: string; expiresAt: string };
      return {
        shortCode: issued.code,
        // The code is only meaningful to the server holding it, and this device
        // is the only one that knows which server that is. Saying so here is
        // what lets the other device be somewhere else entirely.
        shortCodeQualified: formatQualifiedShortCode(issued.code, this.settings.get().serverHost),
        shortCodeExpiresAt: issued.expiresAt
      };
    } catch {
      return undefined;
    }
  }

  public async readPairingCode(code: string): Promise<AcceptedPairing | { readonly error: string }> {
    const typed = parseShortCode(code);
    const resolved =
      typed === undefined ? { ok: true as const, link: code } : await this.redeemShortCode(typed);
    if (!resolved.ok) {
      return { error: resolved.reason };
    }

    const parsed = decodePairingOffer(resolved.link);
    if (!parsed.ok) {
      return { error: parsed.reason };
    }
    this.pendingRendezvous = {
      roomId: parsed.offer.roomId,
      inviteToken: parsed.offer.inviteToken,
      signalUrl: parsed.offer.signalUrl
    };
    this.pairingStartedAt = Date.now();
    return {
      roomId: parsed.offer.roomId,
      inviteToken: parsed.offer.inviteToken,
      signalUrl: parsed.offer.signalUrl,
      peerName: parsed.offer.name,
      peerPublicKeyBase64: toBase64(parsed.offer.publicKey),
      shortAuthenticationString: shortAuthenticationString(
        this.identity.keyPair.publicKey,
        parsed.offer.publicKey
      )
    };
  }

  /**
   * Look a code up, on the server it came from.
   *
   * A code carrying a host is redeemed there, whatever this device is set to.
   * That is what lets two devices on different servers — and in different
   * countries — pair at all: the code says where it is valid, so the two
   * devices no longer have to have agreed in advance.
   */
  private async redeemShortCode(
    typed: ParsedShortCode
  ): Promise<{ ok: true; link: string } | { ok: false; reason: string }> {
    const ours = this.settings.get().serverHost;
    const host = typed.host ?? ours;
    try {
      const response = await fetch(`${httpUrlFor(host)}/pairing-codes/${encodeURIComponent(typed.code)}`, {
        signal: AbortSignal.timeout(15_000)
      });
      if (response.status === 404) {
        return {
          ok: false,
          // The likeliest cause when the servers differ is that the code was
          // never on this one, and "the code is wrong" sends people to check
          // the wrong thing entirely.
          reason:
            typed.host === undefined
              ? `No such code on ${ours}. Codes last ten minutes and work once. If the other device uses a different connection server, ask it for the code with the server on the end — it looks like CODE@server.`
              : `${host} does not have that code. It may have expired, or already been used.`
        };
      }
      if (!response.ok) {
        return { ok: false, reason: `${host} answered with an error (${response.status}).` };
      }
      const body = (await response.json()) as { offer?: string };
      if (typeof body.offer !== "string") {
        return { ok: false, reason: `${host} returned something unreadable.` };
      }
      return { ok: true, link: body.offer };
    } catch {
      return {
        ok: false,
        reason: `Could not reach ${host} to look that code up. Check the address and that both devices are online.`
      };
    }
  }

  private rememberRendezvous(deviceId: DeviceId, where: Rendezvous): void {
    this.store.metadata.connection
      .prepare(
        `INSERT INTO device_rendezvous (device_id, room_id, invite_token, signal_url, updated_at)
         VALUES (@deviceId, @roomId, @inviteToken, @signalUrl, @updatedAt)
         ON CONFLICT(device_id) DO UPDATE SET
           room_id = excluded.room_id,
           invite_token = excluded.invite_token,
           signal_url = excluded.signal_url,
           updated_at = excluded.updated_at`
      )
      .run({
        deviceId,
        roomId: where.roomId,
        inviteToken: where.inviteToken,
        signalUrl: where.signalUrl,
        updatedAt: systemClock.now().toISOString()
      });
  }

  /**
   * Where to meet a paired device again.
   *
   * Both devices rejoin the room they paired in. The signaling server recreates
   * an empty room on demand, so whichever arrives first simply waits.
   */
  public rendezvousFor(deviceId: string): Rendezvous | undefined {
    const row = this.store.metadata.connection
      .prepare("SELECT room_id, invite_token, signal_url FROM device_rendezvous WHERE device_id = ?")
      .get(deviceId) as
      | { room_id: string; invite_token: string; signal_url: string }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const where = {
      roomId: row.room_id,
      inviteToken: row.invite_token,
      signalUrl: row.signal_url
    };
    this.pendingRendezvous = where;
    return where;
  }

  /** The room to sit in at startup, so a peer clicking Sync finds us already there. */
  public standingRendezvous(): (Rendezvous & { readonly deviceId: string; readonly name: string }) | undefined {
    const row = this.store.metadata.connection
      .prepare(
        `SELECT r.device_id, r.room_id, r.invite_token, r.signal_url, d.name
         FROM device_rendezvous r
         JOIN devices d ON d.id = r.device_id
         WHERE d.trust = 'paired'
         ORDER BY r.updated_at DESC
         LIMIT 1`
      )
      .get() as
      | { device_id: string; room_id: string; invite_token: string; signal_url: string; name: string }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const where = {
      deviceId: row.device_id,
      name: row.name,
      roomId: row.room_id,
      inviteToken: row.invite_token,
      signalUrl: row.signal_url
    };
    this.pendingRendezvous = { roomId: where.roomId, inviteToken: where.inviteToken, signalUrl: where.signalUrl };
    return where;
  }

  public sasFor(peerPublicKeyBase64: string): string {
    return shortAuthenticationString(
      this.identity.keyPair.publicKey,
      fromBase64(peerPublicKeyBase64)
    );
  }

  // ---- verifying a new device ----------------------------------------

  /**
   * Hold the handshake open while a person compares the six digits.
   *
   * The number only means something at this moment: the peer has proved it
   * holds the key it presented, but nothing has been pinned and no vault data
   * has moved. Displaying it after pairing already happened — which is what the
   * previous version did, for as long as the sync took — asked the user to
   * audit a decision the app had already made for them.
   */
  private awaitPairingConfirmation(peer: {
    readonly deviceId: DeviceId;
    readonly publicKey: Uint8Array;
    readonly name: string;
  }): Promise<boolean> {
    // A second peer arriving mid-verification would replace the number on
    // screen with one for a different device, which is precisely how a person
    // is tricked into confirming the wrong thing.
    if (this.verification !== undefined) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      this.verification = {
        deviceId: peer.deviceId,
        peerName: peer.name,
        code: shortAuthenticationString(this.identity.keyPair.publicKey, peer.publicKey),
        resolve,
        // Nothing else will free this handshake if the other device walks away
        // mid-verification, and a promise nobody settles keeps the session
        // slot occupied for the rest of the run.
        timer: setTimeout(() => {
          this.settleVerification(false, "The connection was not confirmed in time. Try again.");
        }, 5 * 60_000)
      };
      this.log(`Check the six-digit number shown on ${peer.name} matches the one here.`);
      this.deps.onSnapshotChanged();
    });
  }

  public answerVerification(confirmed: boolean): void {
    const pending = this.verification;
    if (pending === undefined) {
      return;
    }
    this.settleVerification(
      confirmed,
      confirmed
        ? `You confirmed the numbers matched. ${pending.peerName} is connected.`
        : `You said the numbers did not match, so ${pending.peerName} was refused.`
    );
  }

  private settleVerification(confirmed: boolean, message: string): void {
    const pending = this.verification;
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.verification = undefined;
    pending.resolve(confirmed);
    this.log(message);
    this.deps.onSnapshotChanged();
  }

  // ---- device list ----------------------------------------------------

  /**
   * Stop syncing with a device, reversibly.
   *
   * The key stays pinned, so this is a pause rather than a divorce: pressing
   * reconnect puts it straight back. That distinction was invisible before, and
   * "revoke" reads like a door that locks behind you.
   */
  public async disconnectDevice(deviceId: string): Promise<void> {
    await this.trust.revoke(brand<string, "DeviceId">(deviceId) as DeviceId);
    this.log(`Disconnected ${short(deviceId)}. Reconnect it any time from the Devices tab.`);
    this.deps.onSnapshotChanged();
  }

  /** Undo a disconnect, using the key pinned when the device was first verified. */
  public async reconnectDevice(deviceId: string): Promise<void> {
    const known = await this.trust.get(brand<string, "DeviceId">(deviceId) as DeviceId);
    if (known === undefined) {
      throw new Error("That device is no longer known to this one. Connect it again.");
    }
    // Re-pinning the key we ourselves recorded introduces no new trust: the
    // user verified this exact key, and nothing has been able to change it
    // since.
    await this.trust.pair({
      deviceId: known.deviceId,
      publicKey: known.publicKey,
      name: known.name,
      pairedAt: known.pairedAt
    });
    this.log(`Reconnected ${known.name}.`);
    this.deps.onSnapshotChanged();
  }

  /**
   * Erase a device entirely: the pinned key and where to meet it.
   *
   * The genuinely irreversible one — reconnecting afterwards means comparing
   * six digits again — so it is the one the interface asks about.
   */
  public async forgetDevice(deviceId: string): Promise<void> {
    const known = await this.trust.get(brand<string, "DeviceId">(deviceId) as DeviceId);
    this.store.metadata.connection.prepare("DELETE FROM device_rendezvous WHERE device_id = ?").run(deviceId);
    this.store.metadata.connection.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
    this.log(`Forgot ${known?.name ?? short(deviceId)}. Connecting it again starts from scratch.`);
    this.deps.onSnapshotChanged();
  }

  // ---- syncing -------------------------------------------------------

  public async runSession(peerId: string, pairingMode: boolean): Promise<SyncOutcome> {
    if (this.sessionsInFlight.has(peerId)) {
      return { kind: "failed", reason: "A sync with that device is already running." };
    }
    this.sessionsInFlight.add(peerId);

    const link = this.peers.createLink(peerId);
    try {
      const result = await new SyncSession<KdbxCredentialSet>({
        link,
        engine: this.engine,
        // Omitted when this device holds no vault, which makes it adopt the
        // peer's rather than inventing an id that can never match.
        ...(this.vaultId === undefined ? {} : { vaultId: this.vaultId }),
        auth: createAuthenticator({
          keyPair: this.identity.keyPair,
          deviceName: this.identity.name,
          trustStore: this.trust,
          pairingMode,
          confirmPairing: (peer) => this.awaitPairingConfirmation(peer)
        }),
        // A person comparing two screens is slower than a network. The usual
        // thirty seconds would abandon the handshake while they were still
        // reading the number they were asked to read.
        ...(pairingMode ? { options: { timeoutMs: 5 * 60_000 } } : {}),
        onEvent: (event) => {
          if (event.kind === "authenticated") {
            this.log(`Authenticated ${short(event.remoteDeviceId)}.`);
            // Only now do we know which device the current room leads to, so
            // this is the first moment the rendezvous can be recorded.
            if (this.pendingRendezvous !== undefined) {
              this.rememberRendezvous(event.remoteDeviceId, this.pendingRendezvous);
            }
          }
          if (event.kind === "adopted-vault") {
            this.vaultId = event.vaultId;
            this.log(`Joined "${event.name}" from the paired device.`);
          }
        }
      }).run();

      const vaultId = result.vaultId;
      this.vaultId = vaultId;

      this.log(describeSync(result.remoteDevice.name, result.received.length, result.sent.length));

      let conflictId: string | undefined;
      // A peer with nothing to offer reports no head. Both branches below need
      // one, so neither runs — there is nothing to fast-forward to and nothing
      // to conflict with.
      const remoteHead = result.remoteHead;
      if (remoteHead !== undefined) {
        if (result.divergence.kind === "diverged") {
          conflictId = await this.openConflictFor(vaultId, remoteHead);
        } else if (result.divergence.kind === "remote-ahead") {
          // Nothing was discarded, so there is nothing for the user to decide.
          await this.engine.fastForward(vaultId, remoteHead);
          this.log("Brought this device up to date.");
          await this.materializeCurrentVersion();
        }
      }

      this.deps.onSnapshotChanged();
      return {
        kind: "completed",
        received: result.received.length,
        sent: result.sent.length,
        divergence: result.divergence.kind,
        ...(conflictId === undefined ? {} : { conflictId })
      };
    } catch (error) {
      const explained = explainFailure(messageOf(error));
      this.log(explained);
      this.deps.onSnapshotChanged();
      return { kind: "failed", reason: explained };
    } finally {
      // A prompt outliving the session it belongs to would ask the user to
      // confirm a connection that no longer exists.
      this.settleVerification(false, "The other device disconnected before you confirmed.");
      this.sessionsInFlight.delete(peerId);
      this.peers.closeLink(peerId);
    }
  }

  private async openConflictFor(vaultId: VaultId, incomingRevisionId: RevisionId): Promise<string> {
    const vault = await this.store.metadata.getVault(vaultId);
    const current =
      vault?.headRevisionId === undefined
        ? undefined
        : await this.store.metadata.getRevision(vault.headRevisionId);
    const incoming = await this.store.metadata.getRevision(incomingRevisionId);
    if (vault === undefined || current === undefined || incoming === undefined) {
      throw new Error("cannot record a conflict without both revisions");
    }

    const existing = await this.store.metadata.listOpenConflicts(vaultId);
    const already = existing.find(
      (conflict) =>
        conflict.currentRevisionId === current.id && conflict.incomingRevisionId === incoming.id
    );
    if (already !== undefined) {
      return already.id;
    }

    const conflict = openConflict({
      conflictId: cryptoIdGenerator.conflictId(),
      vault,
      currentRevision: current,
      incomingRevision: incoming,
      at: systemClock.now()
    });
    await this.store.metadata.saveConflict(conflict);
    this.log("Both devices changed the vault. Choose how to resolve it.");
    return conflict.id;
  }

  public async resolveConflict(
    conflictId: string,
    decision: "keep-current" | "switch-incoming" | "save-both"
  ): Promise<void> {
    const vaultId = this.requireVaultId();
    const open = await this.store.metadata.listOpenConflicts(vaultId);
    const conflict = open.find((candidate) => candidate.id === conflictId);
    if (conflict === undefined) {
      return;
    }

    if (decision === "switch-incoming") {
      await this.engine.promote(vaultId, conflict.incomingRevisionId);
    }
    // keep-current changes nothing; save-both leaves the fork in place
    // deliberately, so both branches stay reachable in the history.

    await this.store.metadata.saveConflict(
      recordConflictDecision({ conflict, decision: { kind: decision }, at: systemClock.now() })
    );
    this.log(
      decision === "switch-incoming"
        ? "Switched to the other device's version on this device only."
        : decision === "keep-current"
          ? "Kept this device's version. The other device still has its own."
          : "Left both versions in the history."
    );
    await this.materializeCurrentVersion();
    this.deps.onSnapshotChanged();
  }

  // ---- merging (the only path that decrypts) --------------------------

  public async previewMerge(input: {
    baseRevisionId: string;
    incomingRevisionIds: readonly string[];
    password: string;
  }): Promise<{ kind: "ready"; summary: Record<string, number> } | { kind: "failed"; reason: string }> {
    const vaultId = this.requireVaultId();
    const result = await this.engine.previewDiff({
      vaultId,
      baseRevisionId: brand<string, "RevisionId">(input.baseRevisionId),
      incomingRevisionIds: input.incomingRevisionIds.map((id) => brand<string, "RevisionId">(id)),
      credentials: uniformCredentials(input.password, input.incomingRevisionIds.length)
    });

    if (result.kind !== "ready") {
      return { kind: "failed", reason: result.reason };
    }
    return {
      kind: "ready",
      summary: {
        addedEntries: result.diff.addedEntries.length,
        removedEntries: result.diff.removedEntries.length,
        changedEntries: result.diff.changedEntries.length,
        addedGroups: result.diff.addedGroups.length,
        removedGroups: result.diff.removedGroups.length,
        changedGroups: result.diff.changedGroups.length
      }
    };
  }

  public async merge(input: {
    baseRevisionId: string;
    incomingRevisionIds: readonly string[];
    password: string;
  }): Promise<MergeOutcomeSummary> {
    const vaultId = this.requireVaultId();
    const result = await this.engine.merge({
      vaultId,
      baseRevisionId: brand<string, "RevisionId">(input.baseRevisionId),
      incomingRevisionIds: input.incomingRevisionIds.map((id) => brand<string, "RevisionId">(id)),
      credentials: uniformCredentials(input.password, input.incomingRevisionIds.length)
    });

    if (result.kind === "needs-credentials") {
      return { kind: "needs-credentials", reason: result.reason };
    }
    if (result.kind === "failed") {
      this.log(`Merge failed: ${result.reason}`);
      return { kind: "failed", reason: result.reason };
    }

    this.log("Combined both sets of changes into a new version.");
    this.deps.onSnapshotChanged();
    return { kind: "merged", revisionId: result.revision.id };
  }

  // ---- snapshot ------------------------------------------------------

  public async snapshot(): Promise<AppSnapshot> {
    const device = {
      deviceId: this.identity.keyPair.deviceId,
      name: this.identity.name,
      publicKeyBase64: toBase64(this.identity.keyPair.publicKey)
    };

    const knownRendezvous = new Set(
      (
        this.store.metadata.connection
          .prepare("SELECT device_id FROM device_rendezvous")
          .all() as { device_id: string }[]
      ).map((row) => row.device_id)
    );

    const paired = (await this.trust.list()).map((entry) => ({
      deviceId: entry.deviceId,
      name: entry.name,
      trust: entry.trust,
      pairedAt: entry.pairedAt.toISOString(),
      canReconnect: knownRendezvous.has(entry.deviceId),
      ...(entry.lastSeenAt === undefined ? {} : { lastSeenAt: entry.lastSeenAt.toISOString() })
    }));

    if (this.vaultId === undefined) {
      return {
        device,
        state: { kind: "needs-setup" },
        versions: [],
        conflicts: [],
        pairedDevices: paired,
        // Pairing before a vault exists is the normal first run, so the
        // confirmation prompt has to survive this branch too.
        ...(this.verification === undefined
          ? {}
          : { verification: { peerName: this.verification.peerName, code: this.verification.code } }),
        activity: [...this.activity],
        signalUrl: this.signalUrl()
      };
    }

    const vault = await this.store.metadata.getVault(this.vaultId);
    const revisions = await this.store.metadata.listRevisions(this.vaultId);
    const graph = await this.store.metadata.loadGraph(this.vaultId);
    const conflicts = await this.store.metadata.listOpenConflicts(this.vaultId);
    const headId = vault?.headRevisionId;

    const deviceNames = new Map((await this.trust.list()).map((d) => [String(d.deviceId), d.name]));

    const versions = revisions.map((revision) => {
      const fromPeer =
        revision.originDeviceId !== undefined &&
        revision.originDeviceId !== this.identity.keyPair.deviceId;
      const origin =
        revision.operation === "merged"
          ? ("merge" as const)
          : revision.parentIds.length === 0
            ? ("first" as const)
            : fromPeer
              ? ("peer" as const)
              : ("you" as const);

      const peerName =
        revision.originDeviceId === undefined
          ? "another device"
          : (deviceNames.get(String(revision.originDeviceId)) ?? "another device");

      return {
        id: revision.id,
        savedAt: revision.createdAt.toISOString(),
        sizeBytes: revision.sizeBytes,
        origin,
        summary:
          origin === "merge"
            ? "Combined changes from both devices"
            : origin === "first"
              ? "First version"
              : origin === "peer"
                ? `Saved on ${peerName}`
                : "You saved changes in KeePassXC",
        isCurrent: headId === revision.id,
        // Only a genuine fork can be combined. An earlier version is already
        // inside the current one, and a later one just needs restoring.
        canCombine:
          headId !== undefined &&
          revision.id !== headId &&
          classifyDivergence(graph, headId, revision.id).kind === "diverged"
      };
    });

    const state: AppSnapshot["state"] =
      vault === undefined
        ? { kind: "needs-setup" }
        : vault.kdbxPath === undefined
          ? { kind: "needs-file", vaultName: vault.name }
          : conflicts.length > 0
            ? { kind: "conflict" }
            : this.updateHeldBack
              ? { kind: "waiting-for-close" }
              : { kind: "up-to-date" };

    return {
      device,
      state,
      ...(vault === undefined
        ? {}
        : {
            vault: {
              id: vault.id,
              name: vault.name,
              locked: vault.kdbxPath === undefined ? false : await isVaultLocked(vault.kdbxPath),
              ...(vault.kdbxPath === undefined ? {} : { kdbxPath: vault.kdbxPath }),
              ...(headId === undefined ? {} : { headRevisionId: headId })
            }
          }),
      versions,
      conflicts: conflicts.map((conflict: Conflict) => ({
        id: conflict.id,
        currentRevisionId: conflict.currentRevisionId,
        incomingRevisionId: conflict.incomingRevisionId,
        createdAt: conflict.createdAt.toISOString(),
        mergeBaseIds: mergeBasesOf(graph, conflict)
      })),
      pairedDevices: paired,
      ...(this.verification === undefined
        ? {}
        : {
            verification: {
              peerName: this.verification.peerName,
              code: this.verification.code
            }
          }),
      activity: [...this.activity],
      signalUrl: this.signalUrl()
    };
  }

  /**
   * Combine a fork and put the result in use, in one action.
   *
   * Splitting this into "merge" then "promote" made sense to the engine and
   * none at all to a person: they had just told the app to keep both sets of
   * changes, and were then asked to confirm it a second time.
   */
  public async combineAndUse(input: {
    otherVersionId: string;
    password: string;
  }): Promise<MergeOutcomeSummary> {
    const vaultId = this.requireVaultId();
    const vault = await this.store.metadata.getVault(vaultId);
    if (vault?.headRevisionId === undefined) {
      return { kind: "failed", reason: "There is no current version to combine with." };
    }

    const merged = await this.merge({
      baseRevisionId: vault.headRevisionId,
      incomingRevisionIds: [input.otherVersionId],
      password: input.password
    });
    if (merged.kind !== "merged") {
      return merged;
    }

    await this.engine.promote(vaultId, brand<string, "RevisionId">(merged.revisionId));
    for (const conflict of await this.store.metadata.listOpenConflicts(vaultId)) {
      await this.store.metadata.saveConflict(
        recordConflictDecision({ conflict, decision: { kind: "try-merge" }, at: systemClock.now() })
      );
    }
    this.log("Using the combined version. Both devices' changes are kept.");
    await this.materializeCurrentVersion();
    this.deps.onSnapshotChanged();
    this.deps.onSyncSuggested();
    return merged;
  }

  private requireVaultId(): VaultId {
    if (this.vaultId === undefined) {
      throw new Error("No vault is being tracked.");
    }
    return this.vaultId;
  }

  private log(message: string): void {
    this.activity.unshift(`${new Date().toLocaleTimeString()} · ${message}`);
    this.activity.length = Math.min(this.activity.length, MAX_ACTIVITY);
  }
}

function mergeBasesOf(
  graph: import("@passvault/core").RevisionGraph,
  conflict: Conflict
): readonly string[] {
  const divergence = classifyDivergence(graph, conflict.currentRevisionId, conflict.incomingRevisionId);
  return divergence.kind === "diverged" ? divergence.mergeBases : [];
}

function describeSync(peerName: string, received: number, sent: number): string {
  if (received === 0 && sent === 0) {
    return `Checked with ${peerName} — already in step.`;
  }
  const parts: string[] = [];
  if (received > 0) {
    parts.push(`received ${received} change${received === 1 ? "" : "s"}`);
  }
  if (sent > 0) {
    parts.push(`sent ${sent}`);
  }
  return `Synced with ${peerName} — ${parts.join(" and ")}.`;
}

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ConflictId };

/**
 * Say what went wrong in terms of what someone did.
 *
 * The protocol's own words leak into the interface otherwise, and two of them
 * mislead badly. "Revoked" is the internal name for a state the interface calls
 * *disconnected*, so a yellow bar reading "device has been revoked" describes
 * something far more final than pressing Disconnect. Worse, the same words
 * appear on both devices, so neither one learns which of them did it.
 *
 * The prefix is what tells them apart. `peer rejected:` is this device turning
 * the other away; `peer reported:` is the other device turning this one away.
 */
export function explainFailure(reason: string): string {
  const weRejected = reason.includes("peer rejected:");
  const theyRejected = reason.includes("peer reported:");

  if (reason.includes("device has been revoked")) {
    return weRejected
      ? "You disconnected that device here, so it was turned away. Reconnect it under Devices to sync again."
      : "The other device has this one disconnected. Reconnect it there to sync again.";
  }

  if (reason.includes("device is not paired with this one")) {
    return weRejected
      ? "That device is not set up here. Connect it again under Devices."
      : "The other device does not have this one set up. Connect them again.";
  }

  if (reason.includes("device key has changed since pairing")) {
    // Either a reinstall or an impersonation attempt; both need a deliberate
    // re-pairing, and neither should be described as a network problem.
    return theyRejected
      ? "The other device no longer recognises this one's key. Connect them again, comparing the six digits."
      : "That device's key has changed since you connected it. Connect it again, comparing the six digits.";
  }

  if (reason.includes("the pairing numbers were not confirmed")) {
    return "The numbers were not confirmed, so nothing was shared.";
  }

  // Two paired devices that have not chosen a vault yet are in a normal state,
  // not a broken one. Calling it a failure sent people hunting for a bug that
  // was not there.
  if (reason.includes("neither device is tracking a vault")) {
    return "Connected, but no password file has been shared yet. Set one up on either device.";
  }

  if (reason.includes("timed out waiting for")) {
    return "The other device stopped responding. It will try again on its own when both are online.";
  }

  if (reason.includes("A sync with that device is already running")) {
    return "Already syncing with that device.";
  }

  return `Sync failed: ${reason}`;
}

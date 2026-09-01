/**
 * The IPC contract between the renderer and the main process.
 *
 * The split follows capability, not convenience. The main process owns the
 * filesystem, the database, and the private key; the renderer owns the window
 * and the WebRTC stack, because Chromium's implementation lives there. Neither
 * side can reach the other's resources directly — everything crosses this
 * surface, and the preload script exposes only what is listed here.
 */

export type ChannelName = "control" | "bulk";

export interface DeviceSummary {
  readonly deviceId: string;
  readonly name: string;
  readonly publicKeyBase64: string;
}

export interface PairedDeviceSummary {
  readonly deviceId: string;
  readonly name: string;
  readonly trust: "paired" | "revoked";
  readonly pairedAt: string;
  readonly lastSeenAt?: string;
  readonly canReconnect: boolean;
}

/**
 * One saved version, described the way a person would describe it.
 *
 * The identifiers, hashes and DAG edges the engine works in are deliberately
 * not here. Someone syncing their passwords should never have to learn what a
 * revision hash is to understand what happened.
 */
export interface VersionSummary {
  readonly id: string;
  readonly savedAt: string;
  readonly sizeBytes: number;
  /** "You saved this" · "From Desktop" · "Combined changes" · "First version" */
  readonly summary: string;
  readonly origin: "you" | "peer" | "merge" | "first";
  readonly isCurrent: boolean;
  /** True only for versions that genuinely forked from the current one. */
  readonly canCombine: boolean;
}

export type SyncState =
  /** No vault chosen and none received. */
  | { readonly kind: "needs-setup" }
  /** A vault arrived from a peer but has no file on this machine yet. */
  | { readonly kind: "needs-file"; readonly vaultName: string }
  | { readonly kind: "up-to-date" }
  /** Both devices changed things and someone has to decide. */
  | { readonly kind: "conflict" }
  /** The file is open in KeePassXC, so an update is held back. */
  | { readonly kind: "waiting-for-close" };

export interface ConflictSummary {
  readonly id: string;
  readonly currentRevisionId: string;
  readonly incomingRevisionId: string;
  readonly mergeBaseIds: readonly string[];
  readonly createdAt: string;
}

export interface VaultSummary {
  readonly id: string;
  readonly name: string;
  readonly kdbxPath?: string;
  readonly headRevisionId?: string;
  readonly locked: boolean;
}

/**
 * A handshake paused, waiting for a person to compare six digits.
 *
 * Part of the snapshot rather than a one-off event because it must survive
 * every re-render until it is answered. As transient renderer state it appeared
 * and vanished with whatever happened next.
 */
export interface PendingVerification {
  readonly peerName: string;
  readonly code: string;
}

export interface AppSnapshot {
  readonly device: DeviceSummary;
  readonly vault?: VaultSummary;
  readonly state: SyncState;
  readonly versions: readonly VersionSummary[];
  readonly conflicts: readonly ConflictSummary[];
  readonly pairedDevices: readonly PairedDeviceSummary[];
  readonly verification?: PendingVerification;
  readonly activity: readonly string[];
  readonly signalUrl: string;
}

export interface PairingCode {
  /** The full `passvault://` link, for a clipboard shared between devices. */
  readonly code: string;
  /** Eight characters someone can read off one screen and type into another. */
  readonly shortCode?: string;
  /** The same code with the server on the end, for a device set to another one. */
  readonly shortCodeQualified?: string;
  readonly shortCodeExpiresAt?: string;
  /** The server this code lives on. */
  readonly serverHost: string;
  readonly roomId: string;
  readonly inviteToken: string;
  readonly signalUrl: string;
}

export interface Rendezvous {
  readonly roomId: string;
  readonly inviteToken: string;
  readonly signalUrl: string;
  readonly peerName: string;
}

export interface AcceptedPairing {
  readonly roomId: string;
  readonly inviteToken: string;
  readonly signalUrl: string;
  readonly peerName: string;
  readonly peerPublicKeyBase64: string;
  /** Both devices display this; the user confirms the numbers match. */
  readonly shortAuthenticationString: string;
}

/**
 * Where this device meets other devices.
 *
 * Both devices must be able to reach the same server for pairing to work at
 * all, which makes this the one piece of configuration a person may genuinely
 * have to touch — so it is visible rather than buried in an environment
 * variable.
 */
/**
 * An ICE server, spelled out here rather than borrowed from the DOM.
 *
 * The main process has no DOM types — and should not need them to describe a
 * value it only ever forwards. Structurally identical to `RTCIceServer`, so the
 * renderer hands it straight to WebRTC.
 */
export interface IceServer {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

export interface ConnectionSettings {
  readonly serverHost: string;
  readonly turnUrl?: string;
  readonly turnUsername?: string;
  readonly turnCredential?: string;
}

export type SyncOutcome =
  | {
      readonly kind: "completed";
      readonly received: number;
      readonly sent: number;
      readonly divergence: string;
      readonly conflictId?: string;
    }
  | { readonly kind: "failed"; readonly reason: string };

export type WriteBackOutcome =
  | { readonly kind: "written"; readonly path: string }
  | { readonly kind: "refused-locked"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export type MergeOutcomeSummary =
  | { readonly kind: "merged"; readonly revisionId: string }
  | { readonly kind: "needs-credentials"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface PeerFrame {
  readonly peerId: string;
  readonly channel: ChannelName;
  /** Control frames are JSON text; bulk frames are raw bytes. */
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

export interface DesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  /** Main asks the window to sync, because something changed locally. */
  onSyncSuggested(listener: () => void): () => void;

  chooseVault(): Promise<AppSnapshot>;
  /** Write a vault joined from a peer to a file of the user's choosing. */
  saveVaultAs(): Promise<WriteBackOutcome>;
  /** Put an earlier version back in use. The file updates by itself afterwards. */
  restoreVersion(versionId: string): Promise<AppSnapshot>;
  /** Retry a held-back file update once KeePassXC has let go. */
  applyPendingUpdate(): Promise<WriteBackOutcome>;

  connectionSettings(): Promise<ConnectionSettings>;
  saveConnectionSettings(next: ConnectionSettings): Promise<ConnectionSettings>;
  /** Check a server answers and is the right kind of server, before relying on it. */
  testConnectionServer(host: string): Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** STUN, plus the relay if one is configured. The renderer owns WebRTC. */
  iceServers(): Promise<IceServer[]>;

  createPairingCode(): Promise<PairingCode>;
  /** Accepts either the full link or the eight-character code. */
  readPairingCode(code: string): Promise<AcceptedPairing | { readonly error: string }>;
  shortAuthenticationString(peerPublicKeyBase64: string): Promise<string>;
  /** Answer the pending six-digit check. `false` refuses before anything is pinned. */
  answerVerification(confirmed: boolean): void;
  /** Stop syncing, reversibly — the key stays pinned. */
  disconnectDevice(deviceId: string): Promise<AppSnapshot>;
  /** Undo a disconnect without comparing numbers again. */
  reconnectDevice(deviceId: string): Promise<AppSnapshot>;
  /** Erase the device entirely. Connecting again starts from scratch. */
  forgetDevice(deviceId: string): Promise<AppSnapshot>;
  /** Where to meet an already-paired device again. */
  rendezvousFor(deviceId: string): Promise<Rendezvous | { readonly error: string }>;
  /** The room to rejoin at startup so a peer can reach this device. */
  standingRendezvous(): Promise<Rendezvous | undefined>;

  /** Main drives a session over the link the renderer just established. */
  runSession(input: { readonly peerId: string; readonly pairingMode: boolean }): Promise<SyncOutcome>;
  peerInbound(frame: PeerFrame): void;
  peerBuffered(peerId: string, bytes: number): void;
  peerClosed(peerId: string): void;
  onPeerOutbound(listener: (frame: PeerFrame) => void): () => void;

  previewMerge(input: {
    readonly baseRevisionId: string;
    readonly incomingRevisionIds: readonly string[];
    readonly password: string;
  }): Promise<
    | { readonly kind: "ready"; readonly summary: Record<string, number> }
    | { readonly kind: "failed"; readonly reason: string }
  >;
  merge(input: {
    readonly baseRevisionId: string;
    readonly incomingRevisionIds: readonly string[];
    readonly password: string;
  }): Promise<MergeOutcomeSummary>;
  /** Combine a fork and put the result in use in one step. */
  combineAndUse(input: {
    readonly otherVersionId: string;
    readonly password: string;
  }): Promise<MergeOutcomeSummary>;
  resolveConflict(input: {
    readonly conflictId: string;
    readonly decision: "keep-current" | "switch-incoming" | "save-both";
  }): Promise<AppSnapshot>;
}

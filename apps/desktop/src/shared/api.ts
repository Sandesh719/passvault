/**
 * The IPC contract between the renderer and the main process.
 *
 * The split follows capability, not convenience. The main process owns the
 * filesystem, the database, and the private key; the renderer owns the window
 * and the WebRTC stack, because Chromium's implementation lives there. Neither
 * side can reach the other's resources directly — everything crosses this
 * surface, and the preload script exposes only what is listed here.
 *
 * The shapes crossing it belong to the service that produces them, not to the
 * transport: a phone reads the very same snapshot straight out of memory. Only
 * the calling surface below is specific to there being two processes.
 */
import type {
  AcceptedPairing,
  AppSnapshot,
  ConnectionSettings,
  IceServer,
  MergeOutcomeSummary,
  PairingCode,
  NamedRendezvous,
  SyncOutcome,
  WriteBackOutcome
} from "@passvault/services";
import type { ChannelName, PeerFrame } from "@passvault/transport";

export type * from "@passvault/services";
export type { ChannelName, PeerFrame };

export interface DesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  /** Main asks the window to sync, because something changed locally. */
  onSyncSuggested(listener: () => void): () => void;

  /**
   * Pick the .kdbx to track, replacing the current one if there is one.
   *
   * Choosing a file this device already tracks returns to it rather than
   * importing a second copy under a new id.
   */
  chooseVault(): Promise<AppSnapshot>;
  /**
   * Track nothing, keeping the history.
   *
   * A device holding no vault adopts whatever its peer has, so this is the
   * step that lets both devices move onto a different file.
   */
  stopTrackingVault(): Promise<AppSnapshot>;
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
  rendezvousFor(deviceId: string): Promise<NamedRendezvous | { readonly error: string }>;
  /** The room to rejoin at startup so a peer can reach this device. */
  standingRendezvous(): Promise<NamedRendezvous | undefined>;

  /** Main drives a session over the link the renderer just established. */
  runSession(input: { readonly peerId: string; readonly pairingMode: boolean }): Promise<SyncOutcome>;
  peerInbound(frame: PeerFrame): void;
  peerBuffered(peerId: string, bytes: number): void;
  /** Both channels to this peer are open. Presence starts here, not at the session. */
  peerOpen(peerId: string): void;
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

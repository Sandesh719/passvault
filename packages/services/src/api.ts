/**
 * Everything the interface can ask of the application.
 *
 * Named for the application rather than the platform because the interface is
 * the same on both: the desktop serves these over IPC from the main process,
 * and Android answers them from the same JavaScript context. Nothing here
 * mentions a window, a process or a file.
 */
import type {
  AcceptedPairing,
  AppSnapshot,
  ConnectionSettings,
  IceServer,
  MergeOutcomeSummary,
  NamedRendezvous,
  PairingCode,
  SyncOutcome,
  WriteBackOutcome
} from "./snapshot.js";

export interface VaultApi {
  /** Drive a session over a link the transport has just established. */
  runSession(input: { readonly peerId: string; readonly pairingMode: boolean }): Promise<SyncOutcome>;


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

/**
 * What the interface is told about the device's state.
 *
 * These describe the application, not a transport. The desktop app hands them
 * across IPC and a phone reads them from the same object in memory, so they
 * live beside the service that produces them rather than inside either app's
 * plumbing.
 */
import type { ConnectionSettings, IceServer } from "@passvault/core";

export type { ConnectionSettings, IceServer };

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
  /**
   * Reachable right now: a live data channel, and a handshake that said which
   * device is on the other end of it.
   *
   * Sync is only possible while both devices are online at the same moment, so
   * "is it there?" is otherwise something a person can only infer from a sync
   * that never happens.
   */
  readonly online: boolean;
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

/** Where two devices meet. Not a secret: joining still requires proving a key. */
export interface Rendezvous {
  readonly roomId: string;
  readonly inviteToken: string;
  readonly signalUrl: string;
}

/** A rendezvous the app can name, for telling someone which device it leads to. */
export interface NamedRendezvous extends Rendezvous {
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
 * Re-exported, not redeclared.
 *
 * Both of these describe how a device reaches other devices, which is not an
 * IPC concern — a phone needs the same settings and has no IPC at all. Two
 * structurally identical copies would have drifted the first time one grew a
 * field.
 */
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

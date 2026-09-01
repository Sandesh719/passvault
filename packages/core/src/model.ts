import type {
  BookmarkId,
  ConflictId,
  DeviceId,
  RevisionId,
  Sha256Hex,
  TransferId,
  VaultId
} from "./types.js";

export type RevisionOperation =
  | "imported"
  | "received"
  | "merged"
  | "restored"
  | "local-change";

/**
 * An immutable point in a vault's history.
 *
 * There is deliberately no file path here. Revision bytes live in a
 * content-addressed blob store keyed by `hash`, so the location is derivable
 * and a revision can never disagree with the file it names.
 */
export interface Revision {
  readonly id: RevisionId;
  readonly vaultId: VaultId;
  readonly hash: Sha256Hex;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  /** The paired device this revision was authored on, when known. */
  readonly originDeviceId?: DeviceId;
  readonly parentIds: readonly RevisionId[];
  readonly operation: RevisionOperation;
  readonly message?: string;
}

export interface Vault {
  readonly id: VaultId;
  readonly name: string;
  /** The revision currently materialized to the user's .kdbx file. */
  readonly headRevisionId?: RevisionId;
  /** Absolute path of the .kdbx file KeePassXC opens, when this vault is bound to one. */
  readonly kdbxPath?: string;
  readonly createdAt: Date;
}

export interface Bookmark {
  readonly id: BookmarkId;
  readonly vaultId: VaultId;
  readonly revisionId: RevisionId;
  readonly message: string;
  readonly createdAt: Date;
}

export interface HeadRevisionEvent {
  readonly vaultId: VaultId;
  readonly previousRevisionId?: RevisionId;
  readonly nextRevisionId: RevisionId;
  readonly createdAt: Date;
  readonly reason: "promote" | "undo" | "restore" | "fast-forward";
}

export type ConflictStatus = "open" | "resolved" | "deferred";

export type ConflictDecision =
  | { readonly kind: "keep-current" }
  | { readonly kind: "switch-incoming" }
  | { readonly kind: "try-merge" }
  | { readonly kind: "save-both" }
  | { readonly kind: "restore-revision"; readonly revisionId: RevisionId };

export interface Conflict {
  readonly id: ConflictId;
  readonly vaultId: VaultId;
  readonly currentRevisionId: RevisionId;
  readonly incomingRevisionId: RevisionId;
  readonly status: ConflictStatus;
  readonly createdAt: Date;
  readonly resolvedAt?: Date;
  readonly decision?: ConflictDecision;
}

export type TransferStatus = "requested" | "transferring" | "complete" | "failed" | "cancelled";

export type TransferDirection = "inbound" | "outbound";

export interface PendingTransfer {
  readonly id: TransferId;
  readonly vaultId: VaultId;
  readonly revisionId: RevisionId;
  readonly direction: TransferDirection;
  readonly expectedHash: Sha256Hex;
  readonly expectedSizeBytes: number;
  readonly receivedBytes: number;
  readonly status: TransferStatus;
  readonly peerDeviceId: DeviceId;
}

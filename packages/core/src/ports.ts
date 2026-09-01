import type { RevisionGraph } from "./dag.js";
import type {
  Bookmark,
  Conflict,
  HeadRevisionEvent,
  PendingTransfer,
  Revision,
  Vault
} from "./model.js";
import type { ProtocolMessage } from "./protocol.js";
import type { DeviceId, PeerId, RevisionId, Sha256Hex, VaultId } from "./types.js";

export interface HashPort {
  sha256(bytes: Uint8Array): Promise<Sha256Hex>;
}

/**
 * Content-addressed storage for encrypted vault bytes.
 *
 * Keyed by hash, so integrity is structural: a blob that does not hash to its
 * own key is detectable without any extra bookkeeping, and two devices holding
 * identical bytes converge on one entry for free.
 */
export interface BlobStore {
  has(hash: Sha256Hex): Promise<boolean>;
  /** Writes atomically and returns the content hash. Writing existing content is a no-op. */
  put(bytes: Uint8Array): Promise<Sha256Hex>;
  get(hash: Sha256Hex): Promise<Uint8Array>;
  sizeOf(hash: Sha256Hex): Promise<number | undefined>;
  delete(hash: Sha256Hex): Promise<void>;
}

/**
 * Durable metadata. Deliberately excludes vault bytes (see BlobStore) and any
 * credential material, which is never persisted anywhere.
 */
export interface MetadataStore {
  /**
   * Run `body` in a single atomic transaction.
   *
   * Sync sessions interleave revision writes with head moves; a crash between
   * them would leave a DAG that references revisions it does not have. Every
   * multi-write operation goes through here.
   */
  transaction<T>(body: () => Promise<T>): Promise<T>;

  getVault(vaultId: VaultId): Promise<Vault | undefined>;
  listVaults(): Promise<readonly Vault[]>;
  saveVault(vault: Vault): Promise<void>;

  getRevision(revisionId: RevisionId): Promise<Revision | undefined>;
  hasRevision(revisionId: RevisionId): Promise<boolean>;
  listRevisions(vaultId: VaultId): Promise<readonly Revision[]>;
  /**
   * Persist a revision. Implementations must reject a revision whose parents
   * are not already stored, so the DAG can never contain a dangling edge.
   */
  saveRevision(revision: Revision): Promise<void>;
  /** The `{id, parentIds}` projection used by all ancestry reasoning. */
  loadGraph(vaultId: VaultId): Promise<RevisionGraph>;

  appendHeadEvent(event: HeadRevisionEvent): Promise<void>;
  lastHeadEvent(vaultId: VaultId): Promise<HeadRevisionEvent | undefined>;

  saveBookmark(bookmark: Bookmark): Promise<void>;
  listBookmarks(vaultId: VaultId): Promise<readonly Bookmark[]>;

  saveConflict(conflict: Conflict): Promise<void>;
  listOpenConflicts(vaultId: VaultId): Promise<readonly Conflict[]>;

  saveTransfer(transfer: PendingTransfer): Promise<void>;
  listPendingTransfers(vaultId: VaultId): Promise<readonly PendingTransfer[]>;

  /** Last known head of a paired device, used to skip redundant history exchange. */
  recordPeerHead(input: {
    readonly deviceId: DeviceId;
    readonly vaultId: VaultId;
    readonly headRevisionId: RevisionId;
    readonly seenAt: Date;
  }): Promise<void>;
  getPeerHead(deviceId: DeviceId, vaultId: VaultId): Promise<RevisionId | undefined>;

  appendEvent(input: { readonly at: Date; readonly kind: string; readonly payload: string }): Promise<void>;
  listEvents(limit: number): Promise<readonly { readonly at: Date; readonly kind: string; readonly payload: string }[]>;
}

export type AuthOutcome =
  | { readonly kind: "accept"; readonly deviceName: string }
  | { readonly kind: "reject"; readonly reason: string };

/**
 * Decides whether the device on the other end is one we agreed to sync with.
 *
 * Kept as a port so the session stays free of cryptography: it orchestrates a
 * challenge and a signature without knowing what algorithm backs them.
 *
 * This is the gate WebRTC does not provide. DTLS encrypts the pipe but says
 * nothing about who is on it — anyone who obtains the room details can connect.
 */
export interface PeerAuthenticator {
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly publicKey: Uint8Array;
  /** Fresh challenge for the peer. Must be unpredictable. */
  newNonce(): Uint8Array;
  /** Prove to the peer that we hold the private key behind our device id. */
  signChallenge(input: {
    readonly nonce: Uint8Array;
    readonly challengerDeviceId: DeviceId;
    readonly responderDeviceId: DeviceId;
  }): Promise<Uint8Array>;
  /** Check the peer's proof, and that we trust the identity it proves. */
  verifyPeer(input: {
    readonly deviceId: DeviceId;
    readonly publicKey: Uint8Array;
    readonly nonce: Uint8Array;
    readonly signature: Uint8Array;
    readonly claimedName: string;
  }): Promise<AuthOutcome>;
}

/**
 * One ordered, reliable stream to a peer.
 *
 * Modelled on RTCDataChannel but narrow enough that an in-memory pair can
 * implement it, which is what lets a whole sync session run headlessly in tests
 * with no WebRTC stack, no signaling server, and no network.
 */
export interface Channel<T> {
  send(data: T): void;
  /** Bytes queued but not yet handed to the network. */
  readonly bufferedAmount: number;
  /**
   * Resolves once the outbound buffer has drained below its low-water mark.
   *
   * Without awaiting this between chunks, a large vault is pushed into the
   * channel faster than SCTP can drain it and the buffer grows until the
   * connection is torn down. The prototype had no backpressure at all.
   */
  drain(): Promise<void>;
  onMessage(handler: (data: T) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/**
 * A connected peer: JSON control messages on one channel, vault bytes on
 * another. Separating them keeps a multi-megabyte transfer from sitting in
 * front of the acks and cancels that manage it.
 */
export interface PeerLink {
  readonly remotePeerId: PeerId;
  readonly control: Channel<string>;
  readonly bulk: Channel<Uint8Array>;
  close(): void;
}

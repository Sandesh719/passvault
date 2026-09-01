import {
  ChunkAssembler,
  DEFAULT_CHUNK_BYTES,
  PROTOCOL_VERSION,
  buildGraph,
  chunkCountFor,
  classifyDivergence,
  decodeChunkFrame,
  encodeChunkFrame,
  encodeMessage,
  missingRevisions,
  unionGraphs,
  validateRemoteGraph,
  type ChunkFrame,
  type DeviceId,
  type PeerAuthenticator,
  type Divergence,
  type HistorySummaryEntry,
  type PeerLink,
  type ProtocolMessage,
  type RevisionId,
  type VaultId
} from "@passvault/core";
import { ControlInbox, SessionError } from "./controlInbox.js";
import type { SyncEngine } from "./engine.js";

/** Stop pushing into the channel above this, resume once it drains. */
const DEFAULT_HIGH_WATER_BYTES = 1024 * 1024;
/** Chunks that arrived before their header. Bounded so a peer cannot grow it without limit. */
const MAX_ORPHAN_FRAMES = 64;

export interface SessionOptions {
  readonly timeoutMs?: number;
  readonly chunkBytes?: number;
  /** Exposed mainly so tests can drive the backpressure path without a megabyte of data. */
  readonly highWaterBytes?: number;
}

export interface SessionDeps<Credentials> {
  readonly link: PeerLink;
  readonly engine: SyncEngine<Credentials>;
  /**
   * The vault to sync. Omit when this device holds none yet — it will adopt
   * whatever the peer advertises, which is how a newly paired device joins.
   */
  readonly vaultId?: VaultId;
  /** Proves who we are and decides whether to accept who they claim to be. */
  readonly auth: PeerAuthenticator;
  readonly options?: SessionOptions;
  readonly onEvent?: (event: SessionEvent) => void;
}

/** Sentinel for "this device holds no vault", since the field is not optional on the wire. */
const EMPTY_VAULT_ID = "\u0000none" as VaultId;

export type SessionEvent =
  | { readonly kind: "handshake"; readonly remoteDeviceId: DeviceId; readonly remoteDeviceName: string }
  | { readonly kind: "authenticated"; readonly remoteDeviceId: DeviceId }
  | { readonly kind: "adopted-vault"; readonly vaultId: VaultId; readonly name: string }
  | { readonly kind: "requested"; readonly revisionIds: readonly RevisionId[] }
  | { readonly kind: "sending"; readonly revisionId: RevisionId; readonly totalChunks: number }
  | { readonly kind: "sent"; readonly revisionId: RevisionId }
  | { readonly kind: "received"; readonly revisionId: RevisionId }
  | { readonly kind: "rejected"; readonly revisionId: RevisionId; readonly reason: string };

export interface SessionResult {
  readonly vaultId: VaultId;
  readonly remoteDevice: { readonly id: DeviceId; readonly name: string };
  readonly received: readonly RevisionId[];
  readonly sent: readonly RevisionId[];
  /** Requested but never delivered — the peer completed without sending them. */
  readonly missing: readonly RevisionId[];
  readonly divergence: Divergence;
  /** Absent when the peer holds nothing for this vault yet. */
  readonly remoteHead?: RevisionId;
}

/**
 * One synchronization session over a connected peer link.
 *
 * Symmetric: both devices run this same code, so there is no client and no
 * server. Each step is a rendezvous — send ours, await theirs — which keeps the
 * state machine legible and means neither side can be starved by the other's
 * ordering choices.
 *
 * Nothing here decrypts. The entire exchange, including deciding what is
 * missing and whether the histories forked, runs on ciphertext and graph shape.
 */
export class SyncSession<Credentials> {
  private readonly inbox: ControlInbox;
  private readonly chunkBytes: number;
  private readonly highWaterBytes: number;
  private readonly assemblers = new Map<number, { readonly header: InboundHeader; readonly assembler: ChunkAssembler }>();
  private readonly orphanFrames: ChunkFrame[] = [];
  private readonly ackWaiters = new Map<RevisionId, (accepted: { ok: boolean; reason?: string }) => void>();
  private readonly expected = new Set<RevisionId>();
  private readonly received: RevisionId[] = [];
  private readonly sent: RevisionId[] = [];
  private inboundWork: Promise<void> = Promise.resolve();
  private peerCompleted = false;
  private readonly peerComplete: Promise<void>;
  private resolvePeerComplete: () => void = () => undefined;
  private remoteDeviceId: DeviceId | undefined;
  private notifyProgress: (() => void) | undefined;
  /** Settled during the summary exchange; every later step uses this, not deps. */
  private vaultId!: VaultId;

  public constructor(private readonly deps: SessionDeps<Credentials>) {
    this.inbox = new ControlInbox(deps.options?.timeoutMs ?? 30_000);
    this.chunkBytes = deps.options?.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.highWaterBytes = deps.options?.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
    this.peerComplete = new Promise<void>((resolve) => {
      this.resolvePeerComplete = resolve;
    });
  }

  public async run(): Promise<SessionResult> {
    this.attach();
    if (this.deps.vaultId !== undefined) {
      this.vaultId = this.deps.vaultId;
    }

    const remote = await this.handshake();
    const remoteSummary = await this.exchangeVaultSummary();
    const remoteHistory = await this.exchangeHistory();

    validateRemoteGraph(
      remoteHistory.map((entry) => ({ id: entry.revisionId, parentIds: entry.parentIds }))
    );
    const remoteGraph = buildGraph(
      remoteHistory.map((entry) => ({ id: entry.revisionId, parentIds: entry.parentIds }))
    );

    const wanted =
      remoteSummary.headRevisionId === undefined
        ? []
        : await this.computeWants(remoteGraph, remoteSummary.headRevisionId);
    for (const revisionId of wanted) {
      this.expected.add(revisionId);
    }
    this.emit({ kind: "requested", revisionIds: wanted });

    this.send({ type: "want-revisions", vaultId: this.vaultId, revisionIds: wanted });
    const theirWants = await this.inbox.expect("want-revisions");

    // Both directions run at once. Neither blocks the other, because acks and
    // headers travel on the control channel while bytes travel on the bulk one.
    await Promise.all([this.serve(theirWants.revisionIds), this.drainInbound()]);

    this.send({ type: "sync-complete", vaultId: this.vaultId });
    // "sync-complete" has a handler, so it can never be awaited via expect();
    // the handler resolves this promise instead.
    await this.withTimeout(this.peerComplete, "sync-complete from peer");
    // Ingests are dispatched from the channel callback; let the last one land.
    await this.inboundWork;

    if (remoteSummary.headRevisionId !== undefined) {
      await this.deps.engine.recordPeerHead({
        deviceId: remote.id,
        vaultId: this.vaultId,
        headRevisionId: remoteSummary.headRevisionId
      });
    }

    return {
      vaultId: this.vaultId,
      remoteDevice: remote,
      received: [...this.received],
      sent: [...this.sent],
      missing: [...this.expected],
      ...(remoteSummary.headRevisionId === undefined
        ? {}
        : { remoteHead: remoteSummary.headRevisionId }),
      divergence: await this.classify(remoteGraph, remoteSummary.headRevisionId)
    };
  }

  // ---- phases --------------------------------------------------------

  /**
   * Version check, then mutual proof of identity.
   *
   * Nothing about the vault — not even its id — is exchanged until both sides
   * have proven possession of a key the other has pinned.
   */
  private async handshake(): Promise<{ readonly id: DeviceId; readonly name: string }> {
    const ourNonce = this.deps.auth.newNonce();

    this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.deps.auth.deviceId,
      deviceName: this.deps.auth.deviceName,
      publicKey: encodeBase64(this.deps.auth.publicKey),
      nonce: encodeBase64(ourNonce)
    });
    const hello = await this.inbox.expect("hello");

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      // Refuse rather than guess. A peer speaking another version may agree on
      // message names while disagreeing on what they mean.
      this.send({
        type: "error",
        code: "unsupported-version",
        message: `this device speaks protocol ${PROTOCOL_VERSION}, peer speaks ${hello.protocolVersion}`
      });
      throw new SessionError(
        "unsupported-version",
        `peer protocol version ${hello.protocolVersion} is not supported`
      );
    }

    let peerPublicKey: Uint8Array;
    let peerNonce: Uint8Array;
    try {
      peerPublicKey = decodeBase64(hello.publicKey);
      peerNonce = decodeBase64(hello.nonce);
    } catch {
      throw new SessionError("malformed-message", "hello carried an undecodable key or nonce");
    }

    // Answer their challenge before judging their answer to ours, so neither
    // side can stall waiting for the other to go first.
    this.send({
      type: "auth",
      signature: encodeBase64(
        await this.deps.auth.signChallenge({
          nonce: peerNonce,
          challengerDeviceId: hello.deviceId,
          responderDeviceId: this.deps.auth.deviceId
        })
      )
    });
    const auth = await this.inbox.expect("auth");

    let signature: Uint8Array;
    try {
      signature = decodeBase64(auth.signature);
    } catch {
      throw new SessionError("malformed-message", "auth carried an undecodable signature");
    }

    const outcome = await this.deps.auth.verifyPeer({
      deviceId: hello.deviceId,
      publicKey: peerPublicKey,
      nonce: ourNonce,
      signature,
      claimedName: hello.deviceName
    });
    if (outcome.kind === "reject") {
      this.send({ type: "error", code: "unauthorized", message: outcome.reason });
      throw new SessionError("unauthorized", `peer rejected: ${outcome.reason}`);
    }

    this.remoteDeviceId = hello.deviceId;
    const remote = { id: hello.deviceId, name: outcome.deviceName };
    this.emit({ kind: "handshake", remoteDeviceId: remote.id, remoteDeviceName: remote.name });
    this.emit({ kind: "authenticated", remoteDeviceId: remote.id });
    return remote;
  }

  /**
   * Advertise where we stand, and learn where they do.
   *
   * Either side may be empty. A device paired a minute ago holds nothing for
   * this vault, and refusing to talk to it would make first-time join the one
   * case the protocol could not handle.
   */
  /**
   * Agree on which vault this session is about.
   *
   * A vault is created once and joined thereafter. Two devices that each
   * imported the same file separately hold two different vault ids for it, and
   * no amount of syncing can reconcile that — so the mismatch is reported
   * plainly rather than papered over.
   */
  private async exchangeVaultSummary(): Promise<{ readonly headRevisionId?: RevisionId }> {
    const local =
      this.deps.vaultId === undefined
        ? undefined
        : await this.deps.engine.getVault(this.deps.vaultId);

    if (this.deps.vaultId !== undefined && local === undefined) {
      this.send({ type: "error", code: "unknown-vault", message: "this device does not track that vault" });
      throw new SessionError("unknown-vault", "local device does not track this vault");
    }

    if (local !== undefined) {
      this.send({
        type: "vault-summary",
        vaultId: local.id,
        vaultName: local.name,
        revisionCount: await this.deps.engine.revisionCount(local.id),
        ...(local.headRevisionId === undefined ? {} : { headRevisionId: local.headRevisionId })
      });
    } else {
      // Nothing to advertise. The peer's vault is the only candidate.
      this.send({
        type: "vault-summary",
        vaultId: EMPTY_VAULT_ID,
        vaultName: "",
        revisionCount: 0
      });
    }

    const summary = await this.inbox.expect("vault-summary");
    const remoteHasVault = summary.vaultId !== EMPTY_VAULT_ID;

    if (local === undefined && !remoteHasVault) {
      throw new SessionError("unknown-vault", "neither device is tracking a vault yet");
    }

    if (local === undefined) {
      // Adopt the peer's vault, id and all. Minting our own id here is exactly
      // what makes two copies of one file un-syncable.
      await this.deps.engine.adoptVault({ vaultId: summary.vaultId, name: summary.vaultName });
      this.vaultId = summary.vaultId;
      this.emit({ kind: "adopted-vault", vaultId: summary.vaultId, name: summary.vaultName });
    } else if (remoteHasVault && summary.vaultId !== local.id) {
      throw new SessionError(
        "unknown-vault",
        `This device tracks "${local.name}" and the peer tracks "${summary.vaultName}", which are different vaults. ` +
          `A vault must be shared from one device and joined on the other, not imported separately on both.`
      );
    } else {
      this.vaultId = local.id;
    }

    return summary.headRevisionId === undefined ? {} : { headRevisionId: summary.headRevisionId };
  }

  private async exchangeHistory(): Promise<readonly HistorySummaryEntry[]> {
    this.send({
      type: "history-summary",
      vaultId: this.vaultId,
      revisions: await this.deps.engine.historySummary(this.vaultId)
    });
    return (await this.inbox.expect("history-summary")).revisions;
  }

  private async computeWants(
    remoteGraph: ReturnType<typeof buildGraph>,
    remoteHead: RevisionId
  ): Promise<readonly RevisionId[]> {
    const held = new Set<RevisionId>();
    for (const revision of await this.deps.engine.historySummary(this.vaultId)) {
      held.add(revision.revisionId);
    }
    return missingRevisions({
      remoteGraph,
      remoteHead,
      hasLocally: (id) => held.has(id)
    });
  }

  private async classify(
    remoteGraph: ReturnType<typeof buildGraph>,
    remoteHead: RevisionId | undefined
  ): Promise<Divergence> {
    const vault = await this.deps.engine.getVault(this.vaultId);
    const localHead = vault?.headRevisionId;

    // An empty side needs no graph comparison, and the existing vocabulary
    // already says the right thing: whoever has history is ahead. A caller that
    // fast-forwards on "remote-ahead" therefore adopts the peer's history
    // wholesale, which is exactly right for a device joining for the first time.
    if (localHead === undefined && remoteHead === undefined) {
      return { kind: "equal" };
    }
    if (localHead === undefined) {
      return { kind: "remote-ahead" };
    }
    if (remoteHead === undefined) {
      return { kind: "local-ahead" };
    }
    const localNodes = (await this.deps.engine.historySummary(this.vaultId)).map((entry) => ({
      id: entry.revisionId,
      parentIds: entry.parentIds
    }));
    return classifyDivergence(unionGraphs(buildGraph(localNodes), remoteGraph), localHead, remoteHead);
  }

  // ---- outbound ------------------------------------------------------

  private async serve(revisionIds: readonly RevisionId[]): Promise<void> {
    let transferSeq = 0;
    for (const revisionId of revisionIds) {
      const revision = await this.deps.engine.getRevision(revisionId);
      if (revision === undefined) {
        // Skip silently. The peer discovers the shortfall when we complete
        // without having sent it, which it reports rather than treating as fatal.
        continue;
      }
      transferSeq += 1;
      const bytes = await this.deps.engine.bytesOf(revisionId);
      const totalChunks = chunkCountFor(bytes.byteLength, this.chunkBytes);

      this.send({
        type: "revision-header",
        transferSeq,
        vaultId: revision.vaultId,
        revisionId: revision.id,
        hash: revision.hash,
        sizeBytes: revision.sizeBytes,
        parentIds: revision.parentIds,
        totalChunks,
        ...(revision.message === undefined ? {} : { message: revision.message })
      });
      this.emit({ kind: "sending", revisionId, totalChunks });

      const ack = this.awaitAck(revisionId);
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        const start = chunkIndex * this.chunkBytes;
        const payload = bytes.subarray(start, Math.min(start + this.chunkBytes, bytes.byteLength));
        // Yield before the buffer grows without bound. Skipping this is how the
        // prototype could tear down a connection on a large vault.
        if (this.deps.link.bulk.bufferedAmount > this.highWaterBytes) {
          await this.deps.link.bulk.drain();
        }
        this.deps.link.bulk.send(encodeChunkFrame({ transferSeq, chunkIndex, payload }));
      }

      const outcome = await ack;
      if (outcome.ok) {
        this.sent.push(revisionId);
        this.emit({ kind: "sent", revisionId });
      } else {
        this.emit({ kind: "rejected", revisionId, reason: outcome.reason ?? "peer rejected" });
      }
    }
  }

  private awaitAck(revisionId: RevisionId): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.ackWaiters.set(revisionId, resolve);
    });
  }

  // ---- inbound -------------------------------------------------------

  /** Resolves when every requested revision has arrived, or the peer gives up. */
  private drainInbound(): Promise<void> {
    if (this.expected.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.notifyProgress = () => {
        if (this.expected.size === 0 || this.peerCompleted) {
          this.notifyProgress = undefined;
          resolve();
        }
      };
    });
  }

  private onHeader(header: InboundHeader): void {
    this.assemblers.set(header.transferSeq, {
      header,
      assembler: new ChunkAssembler(header.totalChunks, header.sizeBytes)
    });
    // Control and bulk are separate streams, so chunks can beat their header.
    for (let index = this.orphanFrames.length - 1; index >= 0; index -= 1) {
      const frame = this.orphanFrames[index];
      if (frame !== undefined && frame.transferSeq === header.transferSeq) {
        this.orphanFrames.splice(index, 1);
        this.onFrame(frame);
      }
    }
  }

  private onFrame(frame: ChunkFrame): void {
    const entry = this.assemblers.get(frame.transferSeq);
    if (entry === undefined) {
      if (this.orphanFrames.length < MAX_ORPHAN_FRAMES) {
        this.orphanFrames.push({ ...frame, payload: new Uint8Array(frame.payload) });
      }
      return;
    }
    if (!entry.assembler.accept(frame)) {
      this.assemblers.delete(frame.transferSeq);
      this.reject(entry.header.revisionId, "chunk exceeded the declared size");
      return;
    }
    if (entry.assembler.isComplete) {
      this.assemblers.delete(frame.transferSeq);
      this.queueIngest(entry.header, entry.assembler.assemble());
    }
  }

  /**
   * Ingests are serialized behind one another.
   *
   * Revisions arrive parent-first, and `ingestReceivedRevision` refuses a
   * revision whose parents are not yet stored. Running two ingests concurrently
   * would let a child be checked before its parent finished committing.
   */
  private queueIngest(header: InboundHeader, bytes: Uint8Array): void {
    this.inboundWork = this.inboundWork
      .then(async () => {
        const result = await this.deps.engine.ingestReceivedRevision({
          vaultId: header.vaultId,
          revisionId: header.revisionId,
          declaredParentIds: header.parentIds,
          declaredHash: header.hash,
          bytes,
          fromDeviceId: header.fromDeviceId,
          ...(header.message === undefined ? {} : { message: header.message })
        });

        if (result.kind === "rejected") {
          this.reject(header.revisionId, result.reason);
          return;
        }
        this.send({ type: "revision-ack", revisionId: header.revisionId, accepted: true });
        this.expected.delete(header.revisionId);
        this.received.push(header.revisionId);
        this.emit({ kind: "received", revisionId: header.revisionId });
        this.notifyProgress?.();
      })
      .catch((error: unknown) => {
        this.reject(header.revisionId, error instanceof Error ? error.message : "ingest failed");
      });
  }

  private reject(revisionId: RevisionId, reason: string): void {
    this.send({ type: "revision-ack", revisionId, accepted: false, reason });
    this.expected.delete(revisionId);
    this.emit({ kind: "rejected", revisionId, reason });
    this.notifyProgress?.();
  }

  // ---- plumbing ------------------------------------------------------

  private attach(): void {
    // No handler for "hello": handshake() awaits it, and a handler would
    // consume it first.
    this.inbox.on("revision-header", (message) => {
      const fromDeviceId = this.remoteDeviceId;
      if (fromDeviceId === undefined) {
        this.inbox.fail(new SessionError("malformed-message", "revision-header arrived before hello"));
        return;
      }
      this.onHeader({ ...message, fromDeviceId });
    });
    this.inbox.on("revision-ack", (message) => {
      const waiter = this.ackWaiters.get(message.revisionId);
      this.ackWaiters.delete(message.revisionId);
      waiter?.({ ok: message.accepted, ...(message.reason === undefined ? {} : { reason: message.reason }) });
    });
    this.inbox.on("sync-complete", () => {
      this.peerCompleted = true;
      this.resolvePeerComplete();
      this.notifyProgress?.();
    });
    this.inbox.on("transfer-cancel", (message) => {
      const entry = this.assemblers.get(message.transferSeq);
      this.assemblers.delete(message.transferSeq);
      if (entry !== undefined) {
        this.expected.delete(entry.header.revisionId);
        this.emit({ kind: "rejected", revisionId: entry.header.revisionId, reason: message.reason });
        this.notifyProgress?.();
      }
    });

    this.deps.link.control.onMessage((raw) => this.inbox.accept(raw));
    this.deps.link.bulk.onMessage((data) => {
      const frame = decodeChunkFrame(data);
      if (frame !== undefined) {
        this.onFrame(frame);
      }
    });
    this.deps.link.control.onClose(() => {
      this.inbox.fail(new SessionError("closed", "peer closed the control channel"));
    });
  }

  /** Every wait in a session is bounded; a silent peer must not hold one open. */
  private withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const timeoutMs = this.deps.options?.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SessionError("timeout", `timed out waiting for ${label}`));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new SessionError("internal", String(error)));
        }
      );
    });
  }

  private send(message: ProtocolMessage): void {
    this.deps.link.control.send(encodeMessage(message));
  }

  private emit(event: SessionEvent): void {
    this.deps.onEvent?.(event);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface InboundHeader {
  readonly transferSeq: number;
  readonly vaultId: VaultId;
  readonly revisionId: RevisionId;
  readonly hash: import("@passvault/core").Sha256Hex;
  readonly sizeBytes: number;
  readonly parentIds: readonly RevisionId[];
  readonly totalChunks: number;
  readonly message?: string;
  readonly fromDeviceId: DeviceId;
}

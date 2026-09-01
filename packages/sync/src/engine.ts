import {
  assert,
  buildGraph,
  classifyDivergence,
  fastForwardRevision,
  importedRevision,
  localChangeRevision,
  mergedRevision,
  promoteRevision,
  receivedRevision,
  unionGraphs,
  validateRemoteGraph,
  type BlobStore,
  type Clock,
  type DeviceId,
  type Divergence,
  type HashPort,
  type HistorySummaryEntry,
  type IdGenerator,
  type MetadataStore,
  type Revision,
  type RevisionId,
  type RevisionInterpreter,
  type RevisionNode,
  type RevisionSeed,
  type Sha256Hex,
  type VaultDiff,
  type Vault,
  type VaultId
} from "@passvault/core";

export interface EngineDeps<Credentials> {
  readonly metadata: MetadataStore;
  readonly blobs: BlobStore;
  readonly hash: HashPort;
  readonly interpreter: RevisionInterpreter<Credentials>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** This device's durable identity, stamped onto revisions authored here. */
  readonly deviceId: DeviceId;
}

export type LocalChangeResult =
  | { readonly kind: "unchanged"; readonly revisionId: RevisionId }
  | { readonly kind: "recorded"; readonly revision: Revision };

export type IngestResult =
  | { readonly kind: "stored"; readonly revision: Revision }
  | { readonly kind: "already-present"; readonly revisionId: RevisionId }
  | { readonly kind: "rejected"; readonly reason: string };

export type MergeOutcome =
  | { readonly kind: "merged"; readonly revision: Revision }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "needs-credentials"; readonly reason: string };

export type DiffOutcome =
  | { readonly kind: "ready"; readonly diff: VaultDiff }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "needs-credentials"; readonly reason: string };

/**
 * The synchronization engine: everything the prototype did inside a React
 * component, expressed against ports instead.
 *
 * No React, no browser globals, no filesystem. Which platform it runs on is
 * decided entirely by the ports handed to the constructor, so the same engine
 * serves the Electron desktop app and the Android build.
 *
 * Ordering rule used throughout: **blob first, metadata second**. An orphaned
 * blob is harmless and collectable; a metadata row pointing at bytes that were
 * never written is a corrupted history.
 */
export class SyncEngine<Credentials> {
  public constructor(private readonly deps: EngineDeps<Credentials>) {}

  /** Take a .kdbx the user selected and make it the root of a new vault history. */
  public async importVault(input: {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly kdbxPath?: string;
  }): Promise<{ readonly vault: Vault; readonly revision: Revision }> {
    const hash = await this.deps.blobs.put(input.bytes);
    const now = this.deps.clock.now();
    const vaultId = this.deps.ids.vaultId();
    const revision = importedRevision(
      this.seed(vaultId, hash, input.bytes.byteLength, now, input.name),
      this.deps.deviceId
    );

    return this.deps.metadata.transaction(async () => {
      const vault: Vault = {
        id: vaultId,
        name: input.name,
        createdAt: now,
        ...(input.kdbxPath === undefined ? {} : { kdbxPath: input.kdbxPath })
      };
      await this.deps.metadata.saveVault(vault);
      await this.deps.metadata.saveRevision(revision);
      const withHead: Vault = { ...vault, headRevisionId: revision.id };
      await this.deps.metadata.saveVault(withHead);
      await this.deps.metadata.appendHeadEvent({
        vaultId,
        nextRevisionId: revision.id,
        createdAt: now,
        reason: "promote"
      });
      return { vault: withHead, revision };
    });
  }

  /**
   * Record that the vault file changed on this device.
   *
   * Returns `unchanged` when the bytes hash to the current head. File watchers
   * fire on metadata touches and on KeePassXC's own atomic-rename dance, so
   * without this check the history would fill with identical revisions.
   */
  public async recordLocalChange(vaultId: VaultId, bytes: Uint8Array): Promise<LocalChangeResult> {
    const vault = await this.requireVault(vaultId);
    const hash = await this.deps.hash.sha256(bytes);

    if (vault.headRevisionId !== undefined) {
      const head = await this.deps.metadata.getRevision(vault.headRevisionId);
      if (head?.hash === hash) {
        return { kind: "unchanged", revisionId: head.id };
      }
    }

    await this.deps.blobs.put(bytes);
    const now = this.deps.clock.now();
    const revision = localChangeRevision(
      this.seed(vaultId, hash, bytes.byteLength, now),
      vault.headRevisionId,
      this.deps.deviceId
    );

    return this.deps.metadata.transaction(async () => {
      await this.deps.metadata.saveRevision(revision);
      await this.deps.metadata.saveVault({ ...vault, headRevisionId: revision.id });
      await this.deps.metadata.appendHeadEvent({
        vaultId,
        nextRevisionId: revision.id,
        createdAt: now,
        reason: "promote",
        ...(vault.headRevisionId === undefined ? {} : { previousRevisionId: vault.headRevisionId })
      });
      return { kind: "recorded", revision };
    });
  }

  /**
   * Store a revision received from a peer.
   *
   * Two things are non-negotiable here. The bytes are verified against the
   * declared hash before anything is written, and the parents are the sender's
   * declared parents — never our own head. Getting the second one wrong yields
   * a DAG that looks valid and answers every ancestry question incorrectly.
   */
  public async ingestReceivedRevision(input: {
    readonly vaultId: VaultId;
    readonly revisionId: RevisionId;
    readonly declaredParentIds: readonly RevisionId[];
    readonly declaredHash: Sha256Hex;
    readonly bytes: Uint8Array;
    readonly fromDeviceId: DeviceId;
    readonly message?: string;
  }): Promise<IngestResult> {
    if (await this.deps.metadata.hasRevision(input.revisionId)) {
      return { kind: "already-present", revisionId: input.revisionId };
    }

    const actualHash = await this.deps.hash.sha256(input.bytes);
    if (actualHash !== input.declaredHash) {
      return { kind: "rejected", reason: "received bytes do not match the declared hash" };
    }

    for (const parentId of input.declaredParentIds) {
      if (!(await this.deps.metadata.hasRevision(parentId))) {
        return {
          kind: "rejected",
          reason: `parent ${parentId} must be received before ${input.revisionId}`
        };
      }
    }

    await this.deps.blobs.put(input.bytes);
    const revision = receivedRevision(
      {
        // The sender's id is kept, never regenerated. Revision identity is
        // global: two devices must agree on what "revision X" names, or
        // "do I already have this?" becomes unanswerable and every peer
        // re-sends its whole history on every connection.
        id: input.revisionId,
        vaultId: input.vaultId,
        hash: actualHash,
        sizeBytes: input.bytes.byteLength,
        at: this.deps.clock.now(),
        ...(input.message === undefined ? {} : { message: input.message })
      },
      input.declaredParentIds,
      input.fromDeviceId
    );
    // Deliberately does not move the head. What to do about an incoming
    // revision is a separate decision, made after divergence is classified.
    await this.deps.metadata.saveRevision(revision);
    return { kind: "stored", revision };
  }

  /** Compare our head against a peer's, using their history summary. */
  public async divergenceWithPeer(input: {
    readonly vaultId: VaultId;
    readonly remoteNodes: readonly RevisionNode[];
    readonly remoteHead: RevisionId;
  }): Promise<Divergence> {
    validateRemoteGraph(input.remoteNodes);
    const vault = await this.requireVault(input.vaultId);
    assert(vault.headRevisionId !== undefined, "cannot compare a vault with no head");

    const combined = unionGraphs(
      await this.deps.metadata.loadGraph(input.vaultId),
      buildGraph(input.remoteNodes)
    );
    return classifyDivergence(combined, vault.headRevisionId, input.remoteHead);
  }

  /**
   * Merge revisions into a new one. Requires credentials — this is the only
   * engine operation that reaches past the encryption boundary.
   *
   * The output is stored but not promoted. Promotion stays an explicit user act.
   */
  public async merge(input: {
    readonly vaultId: VaultId;
    readonly baseRevisionId: RevisionId;
    readonly incomingRevisionIds: readonly RevisionId[];
    readonly credentials: Credentials;
    readonly message?: string;
  }): Promise<MergeOutcome> {
    const base = await this.requireRevision(input.baseRevisionId);
    const incoming = await Promise.all(
      input.incomingRevisionIds.map((id) => this.requireRevision(id))
    );

    const result = await this.deps.interpreter.merge({
      vaultId: input.vaultId,
      local: { revisionId: base.id, bytes: await this.deps.blobs.get(base.hash) },
      incoming: await Promise.all(
        incoming.map(async (revision) => ({
          revisionId: revision.id,
          bytes: await this.deps.blobs.get(revision.hash)
        }))
      ),
      credentials: input.credentials
    });

    if (result.kind === "needs-credentials") {
      return { kind: "needs-credentials", reason: result.reason };
    }
    if (result.kind !== "merge-succeeded") {
      return { kind: "failed", reason: result.reason };
    }

    const hash = await this.deps.blobs.put(result.bytes);
    const now = this.deps.clock.now();
    const revision = mergedRevision(
      this.seed(
        input.vaultId,
        hash,
        result.bytes.byteLength,
        now,
        input.message ?? `Merged ${incoming.length + 1} revisions`
      ),
      base.id,
      incoming.map((item) => item.id),
      this.deps.deviceId
    );
    await this.deps.metadata.saveRevision(revision);
    return { kind: "merged", revision };
  }

  /** Summarize what merging would bring in, without changing anything. */
  public async previewDiff(input: {
    readonly vaultId: VaultId;
    readonly baseRevisionId: RevisionId;
    readonly incomingRevisionIds: readonly RevisionId[];
    readonly credentials: Credentials;
  }): Promise<DiffOutcome> {
    const base = await this.requireRevision(input.baseRevisionId);
    const incoming = await Promise.all(
      input.incomingRevisionIds.map((id) => this.requireRevision(id))
    );

    const result = await this.deps.interpreter.diff({
      vaultId: input.vaultId,
      local: { revisionId: base.id, bytes: await this.deps.blobs.get(base.hash) },
      incoming: await Promise.all(
        incoming.map(async (revision) => ({
          revisionId: revision.id,
          bytes: await this.deps.blobs.get(revision.hash)
        }))
      ),
      credentials: input.credentials
    });

    if (result.kind === "needs-credentials") {
      return { kind: "needs-credentials", reason: result.reason };
    }
    if (result.kind === "diff-failed") {
      return { kind: "failed", reason: result.reason };
    }
    return { kind: "ready", diff: result.diff };
  }

  /** Deliberate promotion. The user chose this revision. */
  public async promote(vaultId: VaultId, revisionId: RevisionId): Promise<Vault> {
    const vault = await this.requireVault(vaultId);
    const revision = await this.requireRevision(revisionId);
    const { vault: next, event } = promoteRevision({
      vault,
      nextRevision: revision,
      at: this.deps.clock.now()
    });
    return this.deps.metadata.transaction(async () => {
      await this.deps.metadata.saveVault(next);
      await this.deps.metadata.appendHeadEvent(event);
      return next;
    });
  }

  /** Advance to a revision that already contains our head. Not a user decision. */
  public async fastForward(vaultId: VaultId, revisionId: RevisionId): Promise<Vault> {
    const vault = await this.requireVault(vaultId);
    const revision = await this.requireRevision(revisionId);
    const { vault: next, event } = fastForwardRevision({
      vault,
      nextRevision: revision,
      at: this.deps.clock.now()
    });
    return this.deps.metadata.transaction(async () => {
      await this.deps.metadata.saveVault(next);
      await this.deps.metadata.appendHeadEvent(event);
      return next;
    });
  }

  /** Encrypted bytes of a revision, for writing back to the user's .kdbx file. */
  public async bytesOf(revisionId: RevisionId): Promise<Uint8Array> {
    return this.deps.blobs.get((await this.requireRevision(revisionId)).hash);
  }

  /**
   * Register a vault that originated on another device, keeping its id.
   *
   * The id must be the peer's. Generating a fresh one here is what turns "the
   * same vault on two machines" into two vaults that can never reconcile.
   */
  public async adoptVault(input: { readonly vaultId: VaultId; readonly name: string }): Promise<Vault> {
    const existing = await this.deps.metadata.getVault(input.vaultId);
    if (existing !== undefined) {
      return existing;
    }
    const vault: Vault = {
      id: input.vaultId,
      name: input.name,
      createdAt: this.deps.clock.now()
    };
    await this.deps.metadata.saveVault(vault);
    return vault;
  }

  /** Point an adopted vault at a local file once the user chooses where it lives. */
  public async bindVaultToFile(vaultId: VaultId, kdbxPath: string): Promise<Vault> {
    const vault = await this.requireVault(vaultId);
    const bound: Vault = { ...vault, kdbxPath };
    await this.deps.metadata.saveVault(bound);
    return bound;
  }

  public async hasRevision(revisionId: RevisionId): Promise<boolean> {
    return this.deps.metadata.hasRevision(revisionId);
  }

  public async getVault(vaultId: VaultId): Promise<Vault | undefined> {
    return this.deps.metadata.getVault(vaultId);
  }

  public async getRevision(revisionId: RevisionId): Promise<Revision | undefined> {
    return this.deps.metadata.getRevision(revisionId);
  }

  /** Our DAG in the shape a peer needs to work out what it is missing. */
  public async historySummary(vaultId: VaultId): Promise<readonly HistorySummaryEntry[]> {
    const revisions = await this.deps.metadata.listRevisions(vaultId);
    return revisions.map((revision) => ({
      revisionId: revision.id,
      hash: revision.hash,
      sizeBytes: revision.sizeBytes,
      parentIds: revision.parentIds
    }));
  }

  public async revisionCount(vaultId: VaultId): Promise<number> {
    return (await this.deps.metadata.listRevisions(vaultId)).length;
  }

  public async recordPeerHead(input: {
    readonly deviceId: DeviceId;
    readonly vaultId: VaultId;
    readonly headRevisionId: RevisionId;
  }): Promise<void> {
    await this.deps.metadata.recordPeerHead({ ...input, seenAt: this.deps.clock.now() });
  }

  private seed(
    vaultId: VaultId,
    hash: Sha256Hex,
    sizeBytes: number,
    at: Date,
    message?: string
  ): RevisionSeed {
    return {
      id: this.deps.ids.revisionId(),
      vaultId,
      hash,
      sizeBytes,
      at,
      ...(message === undefined ? {} : { message })
    };
  }

  private async requireVault(vaultId: VaultId): Promise<Vault> {
    const vault = await this.deps.metadata.getVault(vaultId);
    assert(vault !== undefined, `unknown vault ${vaultId}`);
    return vault;
  }

  private async requireRevision(revisionId: RevisionId): Promise<Revision> {
    const revision = await this.deps.metadata.getRevision(revisionId);
    assert(revision !== undefined, `unknown revision ${revisionId}`);
    return revision;
  }
}

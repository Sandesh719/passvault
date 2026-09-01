import {
  assert,
  brand,
  buildGraph,
  type Bookmark,
  type Conflict,
  type ConflictDecision,
  type ConflictStatus,
  type DeviceId,
  type HeadRevisionEvent,
  type MetadataStore,
  type PendingTransfer,
  type Revision,
  type RevisionGraph,
  type RevisionId,
  type RevisionNode,
  type RevisionOperation,
  type Sha256Hex,
  type TransferDirection,
  type TransferId,
  type TransferStatus,
  type Vault,
  type VaultId
} from "@passvault/core";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ANCESTORS_CTE, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { openSqlite, type SqlDatabase } from "./sqliteDriver.js";

interface VaultRow {
  readonly id: string;
  readonly name: string;
  readonly kdbx_path: string | null;
  readonly head_revision_id: string | null;
  readonly created_at: string;
}

interface RevisionRow {
  readonly id: string;
  readonly vault_id: string;
  readonly hash: string;
  readonly size_bytes: number;
  readonly created_at: string;
  readonly origin_device_id: string | null;
  readonly operation: string;
  readonly message: string | null;
}

interface HeadEventRow {
  readonly vault_id: string;
  readonly previous_revision_id: string | null;
  readonly next_revision_id: string;
  readonly reason: string;
  readonly created_at: string;
}

interface BookmarkRow {
  readonly id: string;
  readonly vault_id: string;
  readonly revision_id: string;
  readonly message: string;
  readonly created_at: string;
}

interface ConflictRow {
  readonly id: string;
  readonly vault_id: string;
  readonly current_revision_id: string;
  readonly incoming_revision_id: string;
  readonly status: string;
  readonly decision: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

interface TransferRow {
  readonly id: string;
  readonly vault_id: string;
  readonly revision_id: string;
  readonly direction: string;
  readonly expected_hash: string;
  readonly expected_size_bytes: number;
  readonly received_bytes: number;
  readonly status: string;
  readonly peer_device_id: string;
}

interface EventRow {
  readonly at: string;
  readonly kind: string;
  readonly payload: string;
}

/**
 * Local metadata store backed by a single SQLite file.
 *
 * Local in every sense: an embedded library reading one file on disk, with no
 * server, no port, and no network. It is here for transactions and ancestry
 * queries, not for scale.
 */
export class SqliteMetadataStore implements MetadataStore {
  private readonly db: SqlDatabase;
  /**
   * Transactions are serialized rather than nested.
   *
   * better-sqlite3's own `transaction()` helper requires a synchronous body,
   * which cannot span the awaits a sync session performs. So BEGIN/COMMIT are
   * issued manually, and this queue guarantees only one is ever open at a time.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private depth = 0;

  public constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = openSqlite(filePath);
    // Rollback-journal mode: the WASM VFS has no WAL. Still atomic and
    // crash-safe, just without overlapping readers and writers.
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(SCHEMA_SQL);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  public close(): void {
    this.db.close();
  }

  /**
   * The underlying connection, for adapters that need their own tables in the
   * same file and the same transactions — the device trust store, for instance.
   */
  public get connection(): SqlDatabase {
    return this.db;
  }

  public async transaction<T>(body: () => Promise<T>): Promise<T> {
    // An inner transaction joins the outer one; SQLite has no real nesting and
    // savepoints would only add a rollback path nothing currently needs.
    if (this.depth > 0) {
      return body();
    }
    const run = async (): Promise<T> => {
      this.depth += 1;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await body();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.depth -= 1;
      }
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  }

  public async getVault(vaultId: VaultId): Promise<Vault | undefined> {
    const row = this.db.prepare("SELECT * FROM vaults WHERE id = ?").get(vaultId) as VaultRow | undefined;
    return row === undefined ? undefined : toVault(row);
  }

  public async listVaults(): Promise<readonly Vault[]> {
    const rows = this.db.prepare("SELECT * FROM vaults ORDER BY created_at").all() as VaultRow[];
    return rows.map(toVault);
  }

  public async saveVault(vault: Vault): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO vaults (id, name, kdbx_path, head_revision_id, created_at)
         VALUES (@id, @name, @kdbxPath, @headRevisionId, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kdbx_path = excluded.kdbx_path,
           head_revision_id = excluded.head_revision_id`
      )
      .run({
        id: vault.id,
        name: vault.name,
        kdbxPath: vault.kdbxPath ?? null,
        headRevisionId: vault.headRevisionId ?? null,
        createdAt: vault.createdAt.toISOString()
      });
  }

  public async getRevision(revisionId: RevisionId): Promise<Revision | undefined> {
    const row = this.db.prepare("SELECT * FROM revisions WHERE id = ?").get(revisionId) as RevisionRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return toRevision(row, this.parentsOf(revisionId));
  }

  public async hasRevision(revisionId: RevisionId): Promise<boolean> {
    const row = this.db.prepare("SELECT 1 AS present FROM revisions WHERE id = ?").get(revisionId);
    return row !== undefined;
  }

  public async listRevisions(vaultId: VaultId): Promise<readonly Revision[]> {
    const rows = this.db
      .prepare("SELECT * FROM revisions WHERE vault_id = ? ORDER BY created_at DESC")
      .all(vaultId) as RevisionRow[];
    return rows.map((row) => toRevision(row, this.parentsOf(brand<string, "RevisionId">(row.id))));
  }

  /**
   * Persist a revision and its DAG edges.
   *
   * Parents must already exist. A dangling edge would make ancestry queries
   * silently wrong rather than loudly broken, so this is checked at the only
   * point where it can be enforced.
   */
  public async saveRevision(revision: Revision): Promise<void> {
    for (const parentId of revision.parentIds) {
      const present = this.db.prepare("SELECT 1 AS present FROM revisions WHERE id = ?").get(parentId);
      assert(
        present !== undefined,
        `cannot store revision ${revision.id}: parent ${parentId} is not stored yet`
      );
    }

    this.db
      .prepare(
        `INSERT INTO revisions (id, vault_id, hash, size_bytes, created_at, origin_device_id, operation, message)
         VALUES (@id, @vaultId, @hash, @sizeBytes, @createdAt, @originDeviceId, @operation, @message)
         ON CONFLICT(id) DO NOTHING`
      )
      .run({
        id: revision.id,
        vaultId: revision.vaultId,
        hash: revision.hash,
        sizeBytes: revision.sizeBytes,
        createdAt: revision.createdAt.toISOString(),
        originDeviceId: revision.originDeviceId ?? null,
        operation: revision.operation,
        message: revision.message ?? null
      });

    const insertParent = this.db.prepare(
      "INSERT INTO revision_parents (revision_id, parent_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
    );
    for (const parentId of revision.parentIds) {
      insertParent.run(revision.id, parentId);
    }
  }

  public async loadGraph(vaultId: VaultId): Promise<RevisionGraph> {
    const rows = this.db
      .prepare(
        `SELECT r.id AS id, rp.parent_id AS parent_id
         FROM revisions r
         LEFT JOIN revision_parents rp ON rp.revision_id = r.id
         WHERE r.vault_id = ?`
      )
      .all(vaultId) as { readonly id: string; readonly parent_id: string | null }[];

    const parentsById = new Map<string, RevisionId[]>();
    for (const row of rows) {
      const existing = parentsById.get(row.id);
      const parents = existing ?? [];
      if (existing === undefined) {
        parentsById.set(row.id, parents);
      }
      if (row.parent_id !== null) {
        parents.push(brand<string, "RevisionId">(row.parent_id));
      }
    }

    const nodes: RevisionNode[] = [];
    for (const [id, parentIds] of parentsById) {
      nodes.push({ id: brand<string, "RevisionId">(id), parentIds });
    }
    return buildGraph(nodes);
  }

  /** Ancestor ids via a recursive CTE, for spot checks that do not need the whole graph. */
  public ancestorIdsOf(revisionId: RevisionId): readonly RevisionId[] {
    const rows = this.db.prepare(ANCESTORS_CTE).all({ revision: revisionId }) as { readonly id: string }[];
    return rows.map((row) => brand<string, "RevisionId">(row.id));
  }

  public async appendHeadEvent(event: HeadRevisionEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO head_events (vault_id, previous_revision_id, next_revision_id, reason, created_at)
         VALUES (@vaultId, @previousRevisionId, @nextRevisionId, @reason, @createdAt)`
      )
      .run({
        vaultId: event.vaultId,
        previousRevisionId: event.previousRevisionId ?? null,
        nextRevisionId: event.nextRevisionId,
        reason: event.reason,
        createdAt: event.createdAt.toISOString()
      });
  }

  public async lastHeadEvent(vaultId: VaultId): Promise<HeadRevisionEvent | undefined> {
    const row = this.db
      .prepare("SELECT * FROM head_events WHERE vault_id = ? ORDER BY id DESC LIMIT 1")
      .get(vaultId) as HeadEventRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      vaultId: brand<string, "VaultId">(row.vault_id),
      nextRevisionId: brand<string, "RevisionId">(row.next_revision_id),
      reason: row.reason as HeadRevisionEvent["reason"],
      createdAt: new Date(row.created_at),
      ...(row.previous_revision_id === null
        ? {}
        : { previousRevisionId: brand<string, "RevisionId">(row.previous_revision_id) })
    };
  }

  public async saveBookmark(bookmark: Bookmark): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO bookmarks (id, vault_id, revision_id, message, created_at)
         VALUES (@id, @vaultId, @revisionId, @message, @createdAt)
         ON CONFLICT(id) DO UPDATE SET message = excluded.message`
      )
      .run({
        id: bookmark.id,
        vaultId: bookmark.vaultId,
        revisionId: bookmark.revisionId,
        message: bookmark.message,
        createdAt: bookmark.createdAt.toISOString()
      });
  }

  public async listBookmarks(vaultId: VaultId): Promise<readonly Bookmark[]> {
    const rows = this.db
      .prepare("SELECT * FROM bookmarks WHERE vault_id = ? ORDER BY created_at DESC")
      .all(vaultId) as BookmarkRow[];
    return rows.map((row) => ({
      id: brand<string, "BookmarkId">(row.id),
      vaultId: brand<string, "VaultId">(row.vault_id),
      revisionId: brand<string, "RevisionId">(row.revision_id),
      message: row.message,
      createdAt: new Date(row.created_at)
    }));
  }

  public async saveConflict(conflict: Conflict): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO conflicts
           (id, vault_id, current_revision_id, incoming_revision_id, status, decision, created_at, resolved_at)
         VALUES (@id, @vaultId, @currentRevisionId, @incomingRevisionId, @status, @decision, @createdAt, @resolvedAt)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           decision = excluded.decision,
           resolved_at = excluded.resolved_at`
      )
      .run({
        id: conflict.id,
        vaultId: conflict.vaultId,
        currentRevisionId: conflict.currentRevisionId,
        incomingRevisionId: conflict.incomingRevisionId,
        status: conflict.status,
        decision: conflict.decision === undefined ? null : JSON.stringify(conflict.decision),
        createdAt: conflict.createdAt.toISOString(),
        resolvedAt: conflict.resolvedAt?.toISOString() ?? null
      });
  }

  public async listOpenConflicts(vaultId: VaultId): Promise<readonly Conflict[]> {
    const rows = this.db
      .prepare("SELECT * FROM conflicts WHERE vault_id = ? AND status = 'open' ORDER BY created_at DESC")
      .all(vaultId) as ConflictRow[];
    return rows.map((row) => ({
      id: brand<string, "ConflictId">(row.id),
      vaultId: brand<string, "VaultId">(row.vault_id),
      currentRevisionId: brand<string, "RevisionId">(row.current_revision_id),
      incomingRevisionId: brand<string, "RevisionId">(row.incoming_revision_id),
      status: row.status as ConflictStatus,
      createdAt: new Date(row.created_at),
      ...(row.resolved_at === null ? {} : { resolvedAt: new Date(row.resolved_at) }),
      ...(row.decision === null ? {} : { decision: JSON.parse(row.decision) as ConflictDecision })
    }));
  }

  public async saveTransfer(transfer: PendingTransfer): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO transfers
           (id, vault_id, revision_id, direction, expected_hash, expected_size_bytes,
            received_bytes, status, peer_device_id)
         VALUES (@id, @vaultId, @revisionId, @direction, @expectedHash, @expectedSizeBytes,
                 @receivedBytes, @status, @peerDeviceId)
         ON CONFLICT(id) DO UPDATE SET
           received_bytes = excluded.received_bytes,
           status = excluded.status`
      )
      .run({
        id: transfer.id,
        vaultId: transfer.vaultId,
        revisionId: transfer.revisionId,
        direction: transfer.direction,
        expectedHash: transfer.expectedHash,
        expectedSizeBytes: transfer.expectedSizeBytes,
        receivedBytes: transfer.receivedBytes,
        status: transfer.status,
        peerDeviceId: transfer.peerDeviceId
      });
  }

  public async listPendingTransfers(vaultId: VaultId): Promise<readonly PendingTransfer[]> {
    const rows = this.db
      .prepare("SELECT * FROM transfers WHERE vault_id = ? AND status IN ('requested','transferring')")
      .all(vaultId) as TransferRow[];
    return rows.map((row) => ({
      id: brand<string, "TransferId">(row.id) as TransferId,
      vaultId: brand<string, "VaultId">(row.vault_id),
      revisionId: brand<string, "RevisionId">(row.revision_id),
      direction: row.direction as TransferDirection,
      expectedHash: brand<string, "Sha256Hex">(row.expected_hash) as Sha256Hex,
      expectedSizeBytes: row.expected_size_bytes,
      receivedBytes: row.received_bytes,
      status: row.status as TransferStatus,
      peerDeviceId: brand<string, "DeviceId">(row.peer_device_id) as DeviceId
    }));
  }

  public async recordPeerHead(input: {
    readonly deviceId: DeviceId;
    readonly vaultId: VaultId;
    readonly headRevisionId: RevisionId;
    readonly seenAt: Date;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO peer_heads (device_id, vault_id, head_revision_id, seen_at)
         VALUES (@deviceId, @vaultId, @headRevisionId, @seenAt)
         ON CONFLICT(device_id, vault_id) DO UPDATE SET
           head_revision_id = excluded.head_revision_id,
           seen_at = excluded.seen_at`
      )
      .run({
        deviceId: input.deviceId,
        vaultId: input.vaultId,
        headRevisionId: input.headRevisionId,
        seenAt: input.seenAt.toISOString()
      });
  }

  public async getPeerHead(deviceId: DeviceId, vaultId: VaultId): Promise<RevisionId | undefined> {
    const row = this.db
      .prepare("SELECT head_revision_id FROM peer_heads WHERE device_id = ? AND vault_id = ?")
      .get(deviceId, vaultId) as { readonly head_revision_id: string } | undefined;
    return row === undefined ? undefined : brand<string, "RevisionId">(row.head_revision_id);
  }

  public async appendEvent(input: { readonly at: Date; readonly kind: string; readonly payload: string }): Promise<void> {
    this.db
      .prepare("INSERT INTO events (at, kind, payload) VALUES (?, ?, ?)")
      .run(input.at.toISOString(), input.kind, input.payload);
  }

  public async listEvents(
    limit: number
  ): Promise<readonly { readonly at: Date; readonly kind: string; readonly payload: string }[]> {
    const rows = this.db.prepare("SELECT at, kind, payload FROM events ORDER BY id DESC LIMIT ?").all(limit) as EventRow[];
    return rows.map((row) => ({ at: new Date(row.at), kind: row.kind, payload: row.payload }));
  }

  private parentsOf(revisionId: RevisionId): readonly RevisionId[] {
    const rows = this.db
      .prepare("SELECT parent_id FROM revision_parents WHERE revision_id = ?")
      .all(revisionId) as { readonly parent_id: string }[];
    return rows.map((row) => brand<string, "RevisionId">(row.parent_id));
  }
}

function toVault(row: VaultRow): Vault {
  return {
    id: brand<string, "VaultId">(row.id),
    name: row.name,
    createdAt: new Date(row.created_at),
    ...(row.kdbx_path === null ? {} : { kdbxPath: row.kdbx_path }),
    ...(row.head_revision_id === null
      ? {}
      : { headRevisionId: brand<string, "RevisionId">(row.head_revision_id) })
  };
}

function toRevision(row: RevisionRow, parentIds: readonly RevisionId[]): Revision {
  return {
    id: brand<string, "RevisionId">(row.id),
    vaultId: brand<string, "VaultId">(row.vault_id),
    hash: brand<string, "Sha256Hex">(row.hash) as Sha256Hex,
    sizeBytes: row.size_bytes,
    createdAt: new Date(row.created_at),
    parentIds,
    operation: row.operation as RevisionOperation,
    ...(row.origin_device_id === null
      ? {}
      : { originDeviceId: brand<string, "DeviceId">(row.origin_device_id) as DeviceId }),
    ...(row.message === null ? {} : { message: row.message })
  };
}

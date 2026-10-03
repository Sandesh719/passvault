/**
 * Schema for the local metadata database.
 *
 * Holds only metadata: revision identity, DAG edges, device trust, transfer
 * state. Vault bytes live in the blob store and credential material is never
 * persisted at all, so this file leaking reveals the shape of a history but no
 * secrets from inside the vault.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vaults (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  kdbx_path         TEXT,
  head_revision_id  TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  hash              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  origin_device_id  TEXT,
  operation         TEXT NOT NULL,
  message           TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisions_vault ON revisions(vault_id);
CREATE INDEX IF NOT EXISTS idx_revisions_hash  ON revisions(hash);

-- DAG edges live in their own table so ancestry is a query, not a graph walk
-- in application code. parent_id is intentionally not a foreign key: the
-- application enforces closure in saveRevision, which yields a clearer error
-- than a constraint violation and leaves room for partial-history imports.
CREATE TABLE IF NOT EXISTS revision_parents (
  revision_id  TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  parent_id    TEXT NOT NULL,
  PRIMARY KEY (revision_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_revision_parents_parent ON revision_parents(parent_id);

CREATE TABLE IF NOT EXISTS head_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id              TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  previous_revision_id  TEXT,
  next_revision_id      TEXT NOT NULL,
  reason                TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_head_events_vault ON head_events(vault_id, id DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
  id           TEXT PRIMARY KEY,
  vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  revision_id  TEXT NOT NULL,
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_vault ON bookmarks(vault_id);

CREATE TABLE IF NOT EXISTS conflicts (
  id                   TEXT PRIMARY KEY,
  vault_id             TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  current_revision_id  TEXT NOT NULL,
  incoming_revision_id TEXT NOT NULL,
  status               TEXT NOT NULL,
  decision             TEXT,
  created_at           TEXT NOT NULL,
  resolved_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_vault_status ON conflicts(vault_id, status);

CREATE TABLE IF NOT EXISTS transfers (
  id                   TEXT PRIMARY KEY,
  vault_id             TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  revision_id          TEXT NOT NULL,
  direction            TEXT NOT NULL,
  expected_hash        TEXT NOT NULL,
  expected_size_bytes  INTEGER NOT NULL,
  received_bytes       INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL,
  peer_device_id       TEXT NOT NULL,
  chunk_bitmap         BLOB
);
CREATE INDEX IF NOT EXISTS idx_transfers_vault_status ON transfers(vault_id, status);

-- Durable device identities. public_key is what authorization rests on;
-- the ephemeral per-session peer id is deliberately absent here.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  public_key   BLOB NOT NULL,
  name         TEXT NOT NULL,
  trust        TEXT NOT NULL,
  paired_at    TEXT NOT NULL,
  last_seen_at TEXT
);

-- Where to meet a paired device again.
--
-- Pairing happens in a room, and without remembering it the two devices have
-- no way to find each other afterwards. The room is a rendezvous, not a secret:
-- anyone who learned these values could join and would still fail the key
-- check, learning nothing.
CREATE TABLE IF NOT EXISTS device_rendezvous (
  device_id     TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  invite_token  TEXT NOT NULL,
  signal_url    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peer_heads (
  device_id        TEXT NOT NULL,
  vault_id         TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  head_revision_id TEXT NOT NULL,
  seen_at          TEXT NOT NULL,
  PRIMARY KEY (device_id, vault_id)
);

-- Device-local preferences. Which connection server to meet peers on, and a
-- relay to fall back to. Not secrets in the vault sense, but the relay
-- credential is a credential, so this file's permissions still matter.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_id_desc ON events(id DESC);
`;

/**
 * All ancestors of :revision, inclusive.
 *
 * The in-memory graph in core handles bulk sync reasoning; this exists for
 * one-off questions where loading the whole DAG would be wasteful.
 */
export const ANCESTORS_CTE = `
WITH RECURSIVE ancestors(id) AS (
  SELECT @revision
  UNION
  SELECT rp.parent_id
  FROM revision_parents rp
  JOIN ancestors a ON rp.revision_id = a.id
)
SELECT id FROM ancestors
`;

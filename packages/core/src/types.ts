export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type VaultId = Brand<string, "VaultId">;
export type RevisionId = Brand<string, "RevisionId">;
/**
 * Ephemeral identity for one signaling session. Regenerated per connection and
 * meaningless across restarts — never use it to decide trust.
 */
export type PeerId = Brand<string, "PeerId">;
/**
 * Durable cryptographic identity of a paired device: the hash of its public key.
 * Stable across restarts, and the only identity that authorization may rest on.
 */
export type DeviceId = Brand<string, "DeviceId">;
export type RoomId = Brand<string, "RoomId">;
export type TransferId = Brand<string, "TransferId">;
export type ConflictId = Brand<string, "ConflictId">;
export type BookmarkId = Brand<string, "BookmarkId">;
export type Sha256Hex = Brand<string, "Sha256Hex">;
export type FilePath = Brand<string, "FilePath">;

export function brand<T extends string, Name extends string>(value: T): Brand<T, Name> {
  return value as Brand<T, Name>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  vaultId(): VaultId;
  revisionId(): RevisionId;
  transferId(): TransferId;
  conflictId(): ConflictId;
  bookmarkId(): BookmarkId;
}

export const systemClock: Clock = {
  now: () => new Date()
};

/**
 * Ids from the platform CSPRNG. Injected rather than called inline so tests can
 * substitute a deterministic generator and assert on exact DAG shapes.
 */
export const cryptoIdGenerator: IdGenerator = {
  vaultId: () => brand<string, "VaultId">(globalThis.crypto.randomUUID()),
  revisionId: () => brand<string, "RevisionId">(globalThis.crypto.randomUUID()),
  transferId: () => brand<string, "TransferId">(globalThis.crypto.randomUUID()),
  conflictId: () => brand<string, "ConflictId">(globalThis.crypto.randomUUID()),
  bookmarkId: () => brand<string, "BookmarkId">(globalThis.crypto.randomUUID())
};

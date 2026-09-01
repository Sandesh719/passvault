import { assert } from "./assert.js";
import type { Revision } from "./model.js";
import type { DeviceId, RevisionId, Sha256Hex, VaultId } from "./types.js";

/**
 * The only sanctioned way to construct a Revision.
 *
 * Parent lineage is the load-bearing property of this system: divergence
 * detection, merge-base selection, and "what am I missing" all read it as
 * truth. A revision whose parents were guessed rather than known silently
 * corrupts every one of those answers.
 *
 * So each origin gets its own constructor, and none of them can see enough
 * state to fabricate a parent. In particular `receivedRevision` takes the
 * sender's declared parents and has no parameter through which local head
 * state could be substituted — the earlier prototype stamped the local head
 * onto revisions authored on another device, which produced a DAG that was
 * structurally valid and historically false.
 */
export interface RevisionSeed {
  readonly id: RevisionId;
  readonly vaultId: VaultId;
  readonly hash: Sha256Hex;
  readonly sizeBytes: number;
  readonly at: Date;
  readonly message?: string;
}

function base(seed: RevisionSeed): Omit<Revision, "parentIds" | "operation"> {
  assert(seed.sizeBytes >= 0, "revision size must not be negative");
  return {
    id: seed.id,
    vaultId: seed.vaultId,
    hash: seed.hash,
    sizeBytes: seed.sizeBytes,
    createdAt: seed.at,
    ...(seed.message === undefined ? {} : { message: seed.message })
  };
}

/** First revision of a vault. Roots the DAG, so it has no parents by definition. */
export function importedRevision(seed: RevisionSeed, originDeviceId?: DeviceId): Revision {
  return {
    ...base(seed),
    parentIds: [],
    operation: "imported",
    ...(originDeviceId === undefined ? {} : { originDeviceId })
  };
}

/**
 * A change made on this device — the user edited the vault in KeePassXC and the
 * file watcher noticed. Its parent is whatever this device had materialized at
 * the time, which is genuinely its causal predecessor.
 */
export function localChangeRevision(
  seed: RevisionSeed,
  currentHeadId: RevisionId | undefined,
  originDeviceId?: DeviceId
): Revision {
  return {
    ...base(seed),
    parentIds: currentHeadId === undefined ? [] : [currentHeadId],
    operation: "local-change",
    ...(originDeviceId === undefined ? {} : { originDeviceId })
  };
}

/**
 * A revision authored elsewhere. Its parents are a fact about the sender's
 * history and are copied verbatim; local state must not influence them.
 */
export function receivedRevision(
  seed: RevisionSeed,
  declaredParentIds: readonly RevisionId[],
  originDeviceId: DeviceId
): Revision {
  assert(!declaredParentIds.includes(seed.id), "a revision cannot be its own parent");
  return {
    ...base(seed),
    parentIds: [...declaredParentIds],
    operation: "received",
    originDeviceId
  };
}

/** Output of a merge. Records every input as a parent, which is what makes the merge replayable. */
export function mergedRevision(
  seed: RevisionSeed,
  baseRevisionId: RevisionId,
  inputRevisionIds: readonly RevisionId[],
  originDeviceId?: DeviceId
): Revision {
  assert(inputRevisionIds.length > 0, "a merge must have at least one incoming revision");
  const parentIds = [baseRevisionId, ...inputRevisionIds];
  assert(new Set(parentIds).size === parentIds.length, "merge parents must be distinct");
  return {
    ...base(seed),
    parentIds,
    operation: "merged",
    ...(originDeviceId === undefined ? {} : { originDeviceId })
  };
}

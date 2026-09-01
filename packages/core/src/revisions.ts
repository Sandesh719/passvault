import { assert } from "./assert.js";
import type { Bookmark, HeadRevisionEvent, Revision, Vault } from "./model.js";
import type { BookmarkId, RevisionId } from "./types.js";

function moveHead(input: {
  readonly vault: Vault;
  readonly nextRevisionId: RevisionId;
  readonly at: Date;
  readonly reason: HeadRevisionEvent["reason"];
}): { readonly vault: Vault; readonly event: HeadRevisionEvent } {
  const event: HeadRevisionEvent = {
    vaultId: input.vault.id,
    nextRevisionId: input.nextRevisionId,
    createdAt: input.at,
    reason: input.reason,
    ...(input.vault.headRevisionId === undefined ? {} : { previousRevisionId: input.vault.headRevisionId })
  };
  return {
    vault: { ...input.vault, headRevisionId: input.nextRevisionId },
    event
  };
}

/** Deliberate user promotion: make this revision the one materialized to the .kdbx file. */
export function promoteRevision(input: {
  readonly vault: Vault;
  readonly nextRevision: Revision;
  readonly at: Date;
}): { readonly vault: Vault; readonly event: HeadRevisionEvent } {
  assert(input.vault.id === input.nextRevision.vaultId, "cannot promote revision from another vault");
  return moveHead({
    vault: input.vault,
    nextRevisionId: input.nextRevision.id,
    at: input.at,
    reason: "promote"
  });
}

/**
 * Advance the head to a revision that already contains it. Distinct from
 * `promoteRevision` because a fast-forward is not a user decision: no history
 * is discarded and there is nothing to confirm.
 */
export function fastForwardRevision(input: {
  readonly vault: Vault;
  readonly nextRevision: Revision;
  readonly at: Date;
}): { readonly vault: Vault; readonly event: HeadRevisionEvent } {
  assert(input.vault.id === input.nextRevision.vaultId, "cannot fast-forward to a revision from another vault");
  return moveHead({
    vault: input.vault,
    nextRevisionId: input.nextRevision.id,
    at: input.at,
    reason: "fast-forward"
  });
}

export function restoreRevision(input: {
  readonly vault: Vault;
  readonly targetRevision: Revision;
  readonly at: Date;
}): { readonly vault: Vault; readonly event: HeadRevisionEvent } {
  assert(input.vault.id === input.targetRevision.vaultId, "cannot restore revision from another vault");
  return moveHead({
    vault: input.vault,
    nextRevisionId: input.targetRevision.id,
    at: input.at,
    reason: "restore"
  });
}

export function undoLastHeadMove(input: {
  readonly vault: Vault;
  readonly lastEvent: HeadRevisionEvent;
  readonly at: Date;
}): { readonly vault: Vault; readonly event: HeadRevisionEvent } {
  assert(input.lastEvent.vaultId === input.vault.id, "undo event must belong to vault");
  assert(input.lastEvent.previousRevisionId !== undefined, "cannot undo when there is no previous revision");
  return moveHead({
    vault: input.vault,
    nextRevisionId: input.lastEvent.previousRevisionId,
    at: input.at,
    reason: "undo"
  });
}

export function bookmarkRevision(input: {
  readonly bookmarkId: BookmarkId;
  readonly revision: Revision;
  readonly message: string;
  readonly at: Date;
}): Bookmark {
  assert(input.message.trim().length > 0, "bookmark message must not be empty");
  return {
    id: input.bookmarkId,
    vaultId: input.revision.vaultId,
    revisionId: input.revision.id,
    message: input.message,
    createdAt: input.at
  };
}

export function revisionHasParent(revision: Revision, parentId: RevisionId): boolean {
  return revision.parentIds.includes(parentId);
}

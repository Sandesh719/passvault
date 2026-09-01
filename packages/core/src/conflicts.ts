import { assert, assertNever } from "./assert.js";
import type { Conflict, ConflictDecision, Revision, Vault } from "./model.js";
import type { ConflictId } from "./types.js";

export function openConflict(input: {
  readonly conflictId: ConflictId;
  readonly vault: Vault;
  readonly currentRevision: Revision;
  readonly incomingRevision: Revision;
  readonly at: Date;
}): Conflict {
  assert(input.currentRevision.vaultId === input.vault.id, "current revision must belong to vault");
  assert(input.incomingRevision.vaultId === input.vault.id, "incoming revision must belong to vault");
  assert(
    input.vault.headRevisionId === input.currentRevision.id,
    "current revision must be the vault head"
  );

  return {
    id: input.conflictId,
    vaultId: input.vault.id,
    currentRevisionId: input.currentRevision.id,
    incomingRevisionId: input.incomingRevision.id,
    status: "open",
    createdAt: input.at
  };
}

export function recordConflictDecision(input: {
  readonly conflict: Conflict;
  readonly decision: ConflictDecision;
  readonly at: Date;
}): Conflict {
  assert(input.conflict.status === "open", "only open conflicts can be decided");

  switch (input.decision.kind) {
    case "keep-current":
    case "switch-incoming":
    case "try-merge":
    case "restore-revision":
      return {
        ...input.conflict,
        status: "resolved",
        resolvedAt: input.at,
        decision: input.decision
      };
    case "save-both":
      return {
        ...input.conflict,
        status: "deferred",
        resolvedAt: input.at,
        decision: input.decision
      };
    default:
      return assertNever(input.decision);
  }
}

import type { RevisionId, VaultId } from "./types.js";

/**
 * The decryption boundary.
 *
 * Everything else in this system moves and reasons about encrypted bytes. An
 * interpreter is the one component allowed to open a vault, and it is handed
 * bytes rather than paths on purpose: it has no filesystem access, so it cannot
 * write plaintext anywhere even by mistake. Whatever it returns goes back to the
 * caller in memory and is re-encrypted before it touches storage.
 */
export interface RevisionMaterial {
  readonly revisionId: RevisionId;
  readonly bytes: Uint8Array;
}

export interface InterpretationRequest<Credentials> {
  readonly vaultId: VaultId;
  readonly local: RevisionMaterial;
  readonly incoming: readonly RevisionMaterial[];
  readonly credentials?: Credentials;
}

export type InterpretationResult =
  | {
      readonly kind: "merge-succeeded";
      /** Encrypted output. Never plaintext. */
      readonly bytes: Uint8Array;
      readonly parentRevisionIds: readonly RevisionId[];
    }
  | {
      readonly kind: "merge-failed";
      readonly reason: string;
    }
  | {
      readonly kind: "needs-credentials";
      readonly reason: string;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    };

export interface DiffEntrySummary {
  readonly uuid: string;
  readonly title: string;
  readonly groupPath: string;
}

export interface ChangedEntrySummary extends DiffEntrySummary {
  /** Field names only. Values never leave the interpreter. */
  readonly changedFields: readonly string[];
}

export interface VaultDiff {
  readonly addedEntries: readonly DiffEntrySummary[];
  readonly removedEntries: readonly DiffEntrySummary[];
  readonly changedEntries: readonly ChangedEntrySummary[];
  readonly addedGroups: readonly string[];
  readonly removedGroups: readonly string[];
  readonly changedGroups: readonly string[];
}

export type DiffResult =
  | { readonly kind: "diff-ready"; readonly diff: VaultDiff }
  | { readonly kind: "diff-failed"; readonly reason: string }
  | { readonly kind: "needs-credentials"; readonly reason: string };

export interface RevisionInterpreter<Credentials = unknown> {
  merge(request: InterpretationRequest<Credentials>): Promise<InterpretationResult>;
  diff(request: InterpretationRequest<Credentials>): Promise<DiffResult>;
}

export const emptyVaultDiff: VaultDiff = {
  addedEntries: [],
  removedEntries: [],
  changedEntries: [],
  addedGroups: [],
  removedGroups: [],
  changedGroups: []
};

export function mergeVaultDiffs(left: VaultDiff, right: VaultDiff): VaultDiff {
  return {
    addedEntries: [...left.addedEntries, ...right.addedEntries],
    removedEntries: [...left.removedEntries, ...right.removedEntries],
    changedEntries: [...left.changedEntries, ...right.changedEntries],
    addedGroups: [...left.addedGroups, ...right.addedGroups],
    removedGroups: [...left.removedGroups, ...right.removedGroups],
    changedGroups: [...left.changedGroups, ...right.changedGroups]
  };
}

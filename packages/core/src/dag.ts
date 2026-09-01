import { assert } from "./assert.js";
import type { RevisionId } from "./types.js";

/**
 * The minimum a revision must expose to take part in ancestry reasoning.
 * Deliberately narrow: ancestry never needs hashes, bytes, or credentials,
 * which is what lets the whole sync decision layer run on ciphertext.
 */
export interface RevisionNode {
  readonly id: RevisionId;
  readonly parentIds: readonly RevisionId[];
}

/**
 * An in-memory projection of a revision DAG.
 *
 * Ancestry algorithms run against this rather than against storage so that
 * they stay pure and synchronous. A DAG of `{id, parentIds}` is tiny even for
 * tens of thousands of revisions, so loading it whole is cheaper than pushing
 * graph traversal into the database.
 *
 * A graph may be a union of local and remote revisions: that is exactly what
 * divergence classification needs during a sync session.
 */
export interface RevisionGraph {
  get(id: RevisionId): RevisionNode | undefined;
  has(id: RevisionId): boolean;
  readonly size: number;
  ids(): IterableIterator<RevisionId>;
}

export function buildGraph(nodes: Iterable<RevisionNode>): RevisionGraph {
  const byId = new Map<RevisionId, RevisionNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }
  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    get size() {
      return byId.size;
    },
    ids: () => byId.keys()
  };
}

/** Union of two graphs. Nodes in `overlay` win on id collision. */
export function unionGraphs(base: RevisionGraph, overlay: RevisionGraph): RevisionGraph {
  const nodes: RevisionNode[] = [];
  for (const id of base.ids()) {
    const node = base.get(id);
    if (node !== undefined) {
      nodes.push(node);
    }
  }
  for (const id of overlay.ids()) {
    const node = overlay.get(id);
    if (node !== undefined) {
      nodes.push(node);
    }
  }
  return buildGraph(nodes);
}

/**
 * All ancestors of `id`, inclusive of `id` itself.
 *
 * Parents that are not present in the graph are treated as a frontier and
 * skipped rather than throwing: a peer's history summary is legitimately
 * partial, and a missing parent is information ("I need that one"), not an error.
 *
 * Iterative on purpose. This walks peer-supplied data, so a deep or hostile
 * history must not be able to overflow the stack.
 */
export function ancestorsOf(graph: RevisionGraph, id: RevisionId): ReadonlySet<RevisionId> {
  const seen = new Set<RevisionId>();
  const queue: RevisionId[] = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const node = graph.get(current);
    if (node === undefined) {
      continue;
    }
    for (const parentId of node.parentIds) {
      if (!seen.has(parentId)) {
        queue.push(parentId);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by walking parents. Reflexive. */
export function isAncestor(graph: RevisionGraph, ancestor: RevisionId, descendant: RevisionId): boolean {
  if (ancestor === descendant) {
    return true;
  }
  const queue: RevisionId[] = [descendant];
  const seen = new Set<RevisionId>();
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const node = graph.get(current);
    if (node === undefined) {
      continue;
    }
    for (const parentId of node.parentIds) {
      if (parentId === ancestor) {
        return true;
      }
      if (!seen.has(parentId)) {
        queue.push(parentId);
      }
    }
  }
  return false;
}

/**
 * The best common ancestors of `a` and `b`: common ancestors that are not
 * themselves a proper ancestor of another common ancestor.
 *
 * Returns more than one entry only for criss-cross merges. Returns empty when
 * the two revisions share no history at all, which callers should treat as
 * "unrelated vaults" rather than "merge from nothing".
 */
export function findMergeBase(graph: RevisionGraph, a: RevisionId, b: RevisionId): readonly RevisionId[] {
  const ancestorsA = ancestorsOf(graph, a);
  const ancestorsB = ancestorsOf(graph, b);
  const common = new Set<RevisionId>();
  for (const id of ancestorsA) {
    if (ancestorsB.has(id)) {
      common.add(id);
    }
  }
  if (common.size === 0) {
    return [];
  }

  // Anything reachable *from* a common ancestor is a weaker candidate than it.
  const dominated = new Set<RevisionId>();
  for (const candidate of common) {
    const node = graph.get(candidate);
    if (node === undefined) {
      continue;
    }
    for (const parentId of node.parentIds) {
      for (const reachable of ancestorsOf(graph, parentId)) {
        dominated.add(reachable);
      }
    }
  }

  const best: RevisionId[] = [];
  for (const candidate of common) {
    if (!dominated.has(candidate)) {
      best.push(candidate);
    }
  }
  return best;
}

export type Divergence =
  | { readonly kind: "equal" }
  /** Remote head is an ancestor of ours. They are behind; we send, they fast-forward. */
  | { readonly kind: "local-ahead" }
  /** Our head is an ancestor of theirs. We are behind; we receive and fast-forward. */
  | { readonly kind: "remote-ahead" }
  /** Real fork. Neither contains the other. This is what raises a conflict. */
  | { readonly kind: "diverged"; readonly mergeBases: readonly RevisionId[] }
  /** No shared history whatsoever — almost always two different vaults paired by mistake. */
  | { readonly kind: "unrelated" };

/**
 * Classify two heads against a graph that must contain both sides' history
 * (typically the union of the local DAG and a peer's history summary).
 *
 * Note that this needs no vault bytes and no master password: divergence is a
 * property of the DAG's shape, not of the vault's contents. Only *resolving* a
 * divergence by merging requires decryption.
 */
export function classifyDivergence(
  graph: RevisionGraph,
  localHead: RevisionId,
  remoteHead: RevisionId
): Divergence {
  if (localHead === remoteHead) {
    return { kind: "equal" };
  }
  if (isAncestor(graph, remoteHead, localHead)) {
    return { kind: "local-ahead" };
  }
  if (isAncestor(graph, localHead, remoteHead)) {
    return { kind: "remote-ahead" };
  }
  const mergeBases = findMergeBase(graph, localHead, remoteHead);
  if (mergeBases.length === 0) {
    return { kind: "unrelated" };
  }
  return { kind: "diverged", mergeBases };
}

/**
 * Order `ids` so that every parent appears before its children.
 *
 * Insertion order matters: writing a revision whose parents are not yet stored
 * would leave a dangling edge in the DAG, so transfers and database writes both
 * follow this order.
 *
 * Throws on a cycle. Peer-supplied history is untrusted input and a cycle is
 * either corruption or an attack; either way it must not be persisted.
 */
export function topologicalOrder(graph: RevisionGraph, ids: Iterable<RevisionId>): readonly RevisionId[] {
  const target = new Set(ids);
  const ordered: RevisionId[] = [];
  const done = new Set<RevisionId>();
  const onStack = new Set<RevisionId>();

  for (const start of target) {
    if (done.has(start)) {
      continue;
    }
    const stack: { readonly id: RevisionId; expanded: boolean }[] = [{ id: start, expanded: false }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      if (done.has(frame.id)) {
        stack.pop();
        onStack.delete(frame.id);
        continue;
      }
      if (frame.expanded) {
        stack.pop();
        onStack.delete(frame.id);
        done.add(frame.id);
        ordered.push(frame.id);
        continue;
      }
      frame.expanded = true;
      onStack.add(frame.id);
      const node = graph.get(frame.id);
      if (node === undefined) {
        continue;
      }
      for (const parentId of node.parentIds) {
        if (!target.has(parentId) || done.has(parentId)) {
          continue;
        }
        assert(!onStack.has(parentId), `revision graph contains a cycle at ${parentId}`);
        stack.push({ id: parentId, expanded: false });
      }
    }
  }
  return ordered;
}

/**
 * Which revisions behind `remoteHead` we do not already hold, parents first.
 *
 * `remoteGraph` is built from the peer's history summary. Anything it references
 * but does not define is a hole in *their* summary, not something we can request,
 * so it is excluded.
 */
export function missingRevisions(input: {
  readonly remoteGraph: RevisionGraph;
  readonly remoteHead: RevisionId;
  readonly hasLocally: (id: RevisionId) => boolean;
}): readonly RevisionId[] {
  const wanted: RevisionId[] = [];
  for (const id of ancestorsOf(input.remoteGraph, input.remoteHead)) {
    if (!input.hasLocally(id) && input.remoteGraph.has(id)) {
      wanted.push(id);
    }
  }
  return topologicalOrder(input.remoteGraph, wanted);
}

/**
 * Reject a peer's history summary before any of it reaches storage.
 *
 * Checks the two properties that ancestry reasoning depends on and that a peer
 * could violate: no duplicate ids, and no cycles.
 */
export function validateRemoteGraph(nodes: readonly RevisionNode[]): void {
  const seen = new Set<RevisionId>();
  for (const node of nodes) {
    assert(!seen.has(node.id), `history summary repeats revision ${node.id}`);
    seen.add(node.id);
  }
  const graph = buildGraph(nodes);
  // topologicalOrder asserts on cycles; the ordering itself is discarded here.
  topologicalOrder(graph, seen);
}

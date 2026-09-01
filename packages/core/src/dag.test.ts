import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  buildGraph,
  classifyDivergence,
  findMergeBase,
  isAncestor,
  missingRevisions,
  topologicalOrder,
  validateRemoteGraph,
  type RevisionGraph,
  type RevisionNode
} from "./dag.js";
import { brand, type RevisionId } from "./types.js";

const r = (id: string): RevisionId => brand<string, "RevisionId">(id);

/** Compact graph literal: `{ child: [parents] }`. */
function graph(spec: Record<string, readonly string[]>): RevisionGraph {
  const nodes: RevisionNode[] = Object.entries(spec).map(([id, parents]) => ({
    id: r(id),
    parentIds: parents.map(r)
  }));
  return buildGraph(nodes);
}

/**
 *   A1 - A2 - A3 - A4 - A5      (device A)
 *              \
 *               B4 - B5         (device B forked at A3)
 */
const forked = graph({
  A1: [],
  A2: ["A1"],
  A3: ["A2"],
  A4: ["A3"],
  A5: ["A4"],
  B4: ["A3"],
  B5: ["B4"]
});

describe("ancestorsOf", () => {
  it("includes the revision itself", () => {
    expect(ancestorsOf(forked, r("A1")).has(r("A1"))).toBe(true);
  });

  it("walks the whole parent chain", () => {
    expect([...ancestorsOf(forked, r("B5"))].sort()).toEqual(["A1", "A2", "A3", "B4", "B5"]);
  });

  it("treats an unknown parent as a frontier rather than an error", () => {
    const partial = graph({ X2: ["X1"] });
    expect([...ancestorsOf(partial, r("X2"))].sort()).toEqual(["X1", "X2"]);
  });
});

describe("isAncestor", () => {
  it("is reflexive", () => {
    expect(isAncestor(forked, r("A3"), r("A3"))).toBe(true);
  });

  it("follows the chain forwards only", () => {
    expect(isAncestor(forked, r("A2"), r("A5"))).toBe(true);
    expect(isAncestor(forked, r("A5"), r("A2"))).toBe(false);
  });

  it("does not cross a fork", () => {
    expect(isAncestor(forked, r("A4"), r("B5"))).toBe(false);
    expect(isAncestor(forked, r("B4"), r("A5"))).toBe(false);
  });
});

describe("findMergeBase", () => {
  it("finds the fork point", () => {
    expect(findMergeBase(forked, r("A5"), r("B5"))).toEqual([r("A3")]);
  });

  it("returns the nearer ancestor, not every common one", () => {
    expect(findMergeBase(forked, r("A5"), r("B5"))).not.toContain(r("A1"));
  });

  it("returns empty for unrelated histories", () => {
    const two = graph({ A1: [], Z1: [] });
    expect(findMergeBase(two, r("A1"), r("Z1"))).toEqual([]);
  });

  it("reports both bases for a criss-cross merge", () => {
    //  P   Q      two roots
    //  |\ /|
    //  | X |      M1 = (P,Q), M2 = (P,Q)
    //  |/ \|
    //  M1 M2
    const crisscross = graph({
      P: [],
      Q: [],
      M1: ["P", "Q"],
      M2: ["P", "Q"]
    });
    expect([...findMergeBase(crisscross, r("M1"), r("M2"))].sort()).toEqual([r("P"), r("Q")]);
  });
});

describe("classifyDivergence", () => {
  it("detects equality", () => {
    expect(classifyDivergence(forked, r("A3"), r("A3"))).toEqual({ kind: "equal" });
  });

  it("detects that the peer is behind", () => {
    expect(classifyDivergence(forked, r("A5"), r("A3"))).toEqual({ kind: "local-ahead" });
  });

  it("detects that we are behind", () => {
    expect(classifyDivergence(forked, r("A3"), r("A5"))).toEqual({ kind: "remote-ahead" });
  });

  it("detects a real fork and names the merge base", () => {
    expect(classifyDivergence(forked, r("A5"), r("B5"))).toEqual({
      kind: "diverged",
      mergeBases: [r("A3")]
    });
  });

  it("flags histories that share nothing", () => {
    const two = graph({ A1: [], Z1: [] });
    expect(classifyDivergence(two, r("A1"), r("Z1"))).toEqual({ kind: "unrelated" });
  });
});

describe("topologicalOrder", () => {
  it("emits parents before children", () => {
    const ordered = topologicalOrder(forked, [r("B5"), r("A1"), r("B4"), r("A3"), r("A2")]);
    const position = (id: string): number => ordered.indexOf(r(id));
    expect(position("A1")).toBeLessThan(position("A2"));
    expect(position("A2")).toBeLessThan(position("A3"));
    expect(position("A3")).toBeLessThan(position("B4"));
    expect(position("B4")).toBeLessThan(position("B5"));
  });

  it("only orders the requested subset", () => {
    expect(topologicalOrder(forked, [r("A1"), r("A2")])).toEqual([r("A1"), r("A2")]);
  });

  it("rejects a cycle instead of looping forever", () => {
    const cyclic = graph({ C1: ["C2"], C2: ["C1"] });
    expect(() => topologicalOrder(cyclic, [r("C1"), r("C2")])).toThrow(/cycle/u);
  });

  it("survives a history deep enough to overflow a recursive walk", () => {
    const spec: Record<string, readonly string[]> = { N0: [] };
    for (let index = 1; index < 50_000; index += 1) {
      spec[`N${index}`] = [`N${index - 1}`];
    }
    const deep = graph(spec);
    const ordered = topologicalOrder(deep, deep.ids());
    expect(ordered.length).toBe(50_000);
    expect(ordered[0]).toBe(r("N0"));
  });
});

describe("missingRevisions", () => {
  it("asks only for what we lack, parents first", () => {
    const held = new Set(["A1", "A2", "A3"]);
    const wanted = missingRevisions({
      remoteGraph: forked,
      remoteHead: r("B5"),
      hasLocally: (id) => held.has(id)
    });
    expect(wanted).toEqual([r("B4"), r("B5")]);
  });

  it("asks for nothing when already up to date", () => {
    const wanted = missingRevisions({
      remoteGraph: forked,
      remoteHead: r("A5"),
      hasLocally: () => true
    });
    expect(wanted).toEqual([]);
  });

  it("does not request revisions the peer referenced but did not define", () => {
    const partial = graph({ B5: ["B4"] });
    const wanted = missingRevisions({
      remoteGraph: partial,
      remoteHead: r("B5"),
      hasLocally: () => false
    });
    expect(wanted).toEqual([r("B5")]);
  });
});

describe("validateRemoteGraph", () => {
  it("accepts a well-formed summary", () => {
    expect(() =>
      validateRemoteGraph([
        { id: r("A1"), parentIds: [] },
        { id: r("A2"), parentIds: [r("A1")] }
      ])
    ).not.toThrow();
  });

  it("rejects duplicate revision ids", () => {
    expect(() =>
      validateRemoteGraph([
        { id: r("A1"), parentIds: [] },
        { id: r("A1"), parentIds: [] }
      ])
    ).toThrow(/repeats/u);
  });

  it("rejects a cyclic summary", () => {
    expect(() =>
      validateRemoteGraph([
        { id: r("C1"), parentIds: [r("C2")] },
        { id: r("C2"), parentIds: [r("C1")] }
      ])
    ).toThrow(/cycle/u);
  });
});

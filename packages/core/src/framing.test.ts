import { describe, expect, it } from "vitest";
import {
  CHUNK_HEADER_BYTES,
  ChunkAssembler,
  chunkCountFor,
  decodeChunkFrame,
  encodeChunkFrame
} from "./framing.js";

function frame(transferSeq: number, chunkIndex: number, payload: number[]): Uint8Array {
  return encodeChunkFrame({ transferSeq, chunkIndex, payload: new Uint8Array(payload) });
}

describe("chunk framing", () => {
  it("round-trips a frame", () => {
    const decoded = decodeChunkFrame(frame(7, 3, [1, 2, 3, 4]));
    expect(decoded?.transferSeq).toBe(7);
    expect(decoded?.chunkIndex).toBe(3);
    expect(decoded?.payload).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("adds only eight bytes of overhead", () => {
    // The point of binary framing: base64 in JSON cost about 33% of payload.
    const encoded = frame(1, 0, Array.from({ length: 1000 }, () => 0xab));
    expect(encoded.byteLength).toBe(1000 + CHUNK_HEADER_BYTES);
  });

  it("survives the top of the uint32 range", () => {
    const decoded = decodeChunkFrame(frame(0xff_ff_ff_ff, 0xff_ff_ff_fe, [9]));
    expect(decoded?.transferSeq).toBe(0xff_ff_ff_ff);
    expect(decoded?.chunkIndex).toBe(0xff_ff_ff_fe);
  });

  it("returns undefined for a truncated frame rather than throwing", () => {
    expect(decodeChunkFrame(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("carries an empty payload", () => {
    const decoded = decodeChunkFrame(frame(1, 0, []));
    expect(decoded?.payload.byteLength).toBe(0);
  });
});

describe("chunkCountFor", () => {
  it("splits evenly and handles a remainder", () => {
    expect(chunkCountFor(10, 4)).toBe(3);
    expect(chunkCountFor(8, 4)).toBe(2);
  });

  it("uses one chunk for an empty revision", () => {
    // Otherwise the receiver cannot distinguish "zero bytes" from "never started".
    expect(chunkCountFor(0, 4)).toBe(1);
  });
});

describe("ChunkAssembler", () => {
  it("reassembles chunks that arrive out of order", () => {
    const assembler = new ChunkAssembler(3, 6);
    assembler.accept({ transferSeq: 1, chunkIndex: 2, payload: new Uint8Array([5, 6]) });
    assembler.accept({ transferSeq: 1, chunkIndex: 0, payload: new Uint8Array([1, 2]) });
    expect(assembler.isComplete).toBe(false);
    assembler.accept({ transferSeq: 1, chunkIndex: 1, payload: new Uint8Array([3, 4]) });

    expect(assembler.isComplete).toBe(true);
    expect(assembler.assemble()).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("treats a duplicate chunk as a no-op", () => {
    const assembler = new ChunkAssembler(2, 4);
    const chunk = { transferSeq: 1, chunkIndex: 0, payload: new Uint8Array([1, 2]) };
    expect(assembler.accept(chunk)).toBe(true);
    expect(assembler.accept(chunk)).toBe(true);
    expect(assembler.receivedBytes).toBe(2);
  });

  it("rejects a chunk index outside the declared range", () => {
    const assembler = new ChunkAssembler(2, 4);
    expect(assembler.accept({ transferSeq: 1, chunkIndex: 5, payload: new Uint8Array([1]) })).toBe(false);
  });

  it("rejects payloads that would exceed the declared size", () => {
    // A peer must not be able to make us allocate more than it announced.
    const assembler = new ChunkAssembler(2, 4);
    assembler.accept({ transferSeq: 1, chunkIndex: 0, payload: new Uint8Array([1, 2]) });
    expect(
      assembler.accept({ transferSeq: 1, chunkIndex: 1, payload: new Uint8Array([1, 2, 3, 4, 5]) })
    ).toBe(false);
  });

  it("reports what is still missing", () => {
    const assembler = new ChunkAssembler(3, 6);
    assembler.accept({ transferSeq: 1, chunkIndex: 1, payload: new Uint8Array([3, 4]) });
    expect(assembler.missingIndices()).toEqual([0, 2]);
  });

  it("refuses to assemble while incomplete", () => {
    const assembler = new ChunkAssembler(2, 4);
    assembler.accept({ transferSeq: 1, chunkIndex: 0, payload: new Uint8Array([1, 2]) });
    expect(() => assembler.assemble()).toThrow(/incomplete/u);
  });

  it("copies payloads instead of retaining transport buffers", () => {
    const assembler = new ChunkAssembler(1, 2);
    const scratch = new Uint8Array([7, 8]);
    assembler.accept({ transferSeq: 1, chunkIndex: 0, payload: scratch });
    scratch.fill(0);
    expect(assembler.assemble()).toEqual(new Uint8Array([7, 8]));
  });
});

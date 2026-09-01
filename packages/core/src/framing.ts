import { assert } from "./assert.js";

/**
 * Binary framing for vault bytes on the bulk channel.
 *
 * The prototype sent chunks as base64 inside JSON, which cost 33% more wire
 * bytes than the payload itself and forced a string round-trip on both ends.
 * WebRTC data channels carry binary natively, so there is no reason to pay it.
 *
 *   bytes 0..4   transferSeq  uint32 big-endian
 *   bytes 4..8   chunkIndex   uint32 big-endian
 *   bytes 8..    payload
 *
 * `transferSeq` is a session-scoped counter rather than a revision id: four
 * bytes instead of thirty-six on every single chunk. The control channel's
 * revision-header maps it back to a revision before any chunk arrives.
 */
export const CHUNK_HEADER_BYTES = 8;

/** 64 KiB payload. Comfortably under the 256 KiB message ceiling SCTP implementations agree on. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

const MAX_UINT32 = 0xff_ff_ff_ff;

export function encodeChunkFrame(input: {
  readonly transferSeq: number;
  readonly chunkIndex: number;
  readonly payload: Uint8Array;
}): Uint8Array {
  assert(Number.isInteger(input.transferSeq) && input.transferSeq >= 0 && input.transferSeq <= MAX_UINT32,
    "transferSeq must fit in uint32");
  assert(Number.isInteger(input.chunkIndex) && input.chunkIndex >= 0 && input.chunkIndex <= MAX_UINT32,
    "chunkIndex must fit in uint32");

  const frame = new Uint8Array(CHUNK_HEADER_BYTES + input.payload.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, CHUNK_HEADER_BYTES);
  view.setUint32(0, input.transferSeq, false);
  view.setUint32(4, input.chunkIndex, false);
  frame.set(input.payload, CHUNK_HEADER_BYTES);
  return frame;
}

export interface ChunkFrame {
  readonly transferSeq: number;
  readonly chunkIndex: number;
  readonly payload: Uint8Array;
}

/**
 * Decode a frame from the bulk channel.
 *
 * Returns undefined rather than throwing on a short or malformed frame: this is
 * peer input, and a corrupt frame should fail the transfer, not the process.
 */
export function decodeChunkFrame(frame: Uint8Array): ChunkFrame | undefined {
  if (frame.byteLength < CHUNK_HEADER_BYTES) {
    return undefined;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    transferSeq: view.getUint32(0, false),
    chunkIndex: view.getUint32(4, false),
    payload: frame.subarray(CHUNK_HEADER_BYTES)
  };
}

export function chunkCountFor(sizeBytes: number, chunkBytes: number = DEFAULT_CHUNK_BYTES): number {
  assert(sizeBytes >= 0, "size must not be negative");
  assert(chunkBytes > 0, "chunk size must be positive");
  // An empty revision still needs one frame, otherwise the receiver cannot tell
  // "zero bytes transferred" from "transfer never started".
  return Math.max(1, Math.ceil(sizeBytes / chunkBytes));
}

/**
 * Reassembles chunks for one inbound transfer.
 *
 * Tracks which indices have arrived rather than appending blindly, so a
 * duplicate frame is idempotent, an out-of-order frame is fine, and a missing
 * frame is detected at completion instead of producing silently truncated bytes.
 */
export class ChunkAssembler {
  private readonly chunks = new Map<number, Uint8Array>();
  private received = 0;

  public constructor(
    public readonly totalChunks: number,
    public readonly expectedSizeBytes: number
  ) {
    assert(totalChunks > 0, "a transfer must have at least one chunk");
  }

  /** Returns false when the frame is out of range or would exceed the declared size. */
  public accept(frame: ChunkFrame): boolean {
    if (frame.chunkIndex >= this.totalChunks) {
      return false;
    }
    if (this.chunks.has(frame.chunkIndex)) {
      return true;
    }
    const projected = this.received + frame.payload.byteLength;
    if (projected > this.expectedSizeBytes) {
      return false;
    }
    // The payload is a view onto the transport's buffer, which may be recycled.
    this.chunks.set(frame.chunkIndex, new Uint8Array(frame.payload));
    this.received = projected;
    return true;
  }

  public get isComplete(): boolean {
    return this.chunks.size === this.totalChunks && this.received === this.expectedSizeBytes;
  }

  public get receivedBytes(): number {
    return this.received;
  }

  public missingIndices(): readonly number[] {
    const missing: number[] = [];
    for (let index = 0; index < this.totalChunks; index += 1) {
      if (!this.chunks.has(index)) {
        missing.push(index);
      }
    }
    return missing;
  }

  public assemble(): Uint8Array {
    assert(this.isComplete, "cannot assemble an incomplete transfer");
    const output = new Uint8Array(this.expectedSizeBytes);
    let offset = 0;
    for (let index = 0; index < this.totalChunks; index += 1) {
      const chunk = this.chunks.get(index);
      assert(chunk !== undefined, `missing chunk ${index}`);
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

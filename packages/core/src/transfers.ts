import { assert } from "./assert.js";
import type { PendingTransfer, Revision, TransferDirection } from "./model.js";
import type { DeviceId, TransferId } from "./types.js";

export interface ChunkPlan {
  readonly chunkIndex: number;
  readonly offset: number;
  readonly length: number;
}

export function planChunks(sizeBytes: number, chunkSizeBytes: number): readonly ChunkPlan[] {
  assert(sizeBytes >= 0, "size must not be negative");
  assert(chunkSizeBytes > 0, "chunk size must be positive");

  const totalChunks = Math.ceil(sizeBytes / chunkSizeBytes);
  return Array.from({ length: totalChunks }, (_, chunkIndex) => {
    const offset = chunkIndex * chunkSizeBytes;
    return {
      chunkIndex,
      offset,
      length: Math.min(chunkSizeBytes, sizeBytes - offset)
    };
  });
}

export function createPendingTransfer(input: {
  readonly transferId: TransferId;
  readonly revision: Revision;
  readonly direction: TransferDirection;
  readonly peerDeviceId: DeviceId;
}): PendingTransfer {
  return {
    id: input.transferId,
    vaultId: input.revision.vaultId,
    revisionId: input.revision.id,
    direction: input.direction,
    expectedHash: input.revision.hash,
    expectedSizeBytes: input.revision.sizeBytes,
    receivedBytes: 0,
    status: "requested",
    peerDeviceId: input.peerDeviceId
  };
}

export function markTransferComplete(input: {
  readonly transfer: PendingTransfer;
  readonly actualHash: string;
  readonly actualSizeBytes: number;
}): PendingTransfer {
  assert(input.actualHash === input.transfer.expectedHash, "completed transfer hash must match");
  assert(input.actualSizeBytes === input.transfer.expectedSizeBytes, "completed transfer size must match");

  return {
    ...input.transfer,
    receivedBytes: input.actualSizeBytes,
    status: "complete"
  };
}

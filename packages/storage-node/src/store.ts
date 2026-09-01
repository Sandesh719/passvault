import { asSha256Hex, type HashPort, type Sha256Hex } from "@passvault/core";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { FileBlobStore } from "./blobStore.js";
import { SqliteMetadataStore } from "./sqliteMetadataStore.js";

export const nodeHashPort: HashPort = {
  async sha256(bytes: Uint8Array): Promise<Sha256Hex> {
    return asSha256Hex(createHash("sha256").update(bytes).digest("hex"));
  }
};

export interface LocalStore {
  readonly blobs: FileBlobStore;
  readonly metadata: SqliteMetadataStore;
  readonly hash: HashPort;
  close(): void;
}

/**
 * Open (or create) a device's local store.
 *
 * Layout under `rootDir`:
 *   blobs/<aa>/<sha256>.kdbx   encrypted revision bytes, content-addressed
 *   tmp/                       in-flight writes, swept at startup
 *   metadata.db                revision DAG, device trust, transfer state
 */
export async function openLocalStore(rootDir: string): Promise<LocalStore> {
  const blobs = new FileBlobStore(rootDir);
  await blobs.init();
  // A crash mid-write leaves a .part file behind; nothing references it.
  await blobs.sweepTemp();
  const metadata = new SqliteMetadataStore(join(rootDir, "metadata.db"));
  return {
    blobs,
    metadata,
    hash: nodeHashPort,
    close: () => metadata.close()
  };
}

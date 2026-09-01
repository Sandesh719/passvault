import { asSha256Hex, assert, type BlobStore, type Sha256Hex } from "@passvault/core";
import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export function sha256Sync(bytes: Uint8Array): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(bytes).digest("hex"));
}

/**
 * Content-addressed store for encrypted vault bytes on a local filesystem.
 *
 * One global store rather than one per vault: the hash is already globally
 * unique, so a single namespace deduplicates identical revisions across vaults
 * and leaves exactly one place to garbage-collect.
 *
 * Files are sharded one level deep by the first two hex characters. A flat
 * directory works fine at personal scale but degrades badly on some filesystems
 * once it holds tens of thousands of entries, and sharding costs nothing.
 */
export class FileBlobStore implements BlobStore {
  private readonly blobsDir: string;
  private readonly tmpDir: string;

  public constructor(private readonly rootDir: string) {
    this.blobsDir = join(rootDir, "blobs");
    this.tmpDir = join(rootDir, "tmp");
  }

  public async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
  }

  public async has(hash: Sha256Hex): Promise<boolean> {
    return (await this.sizeOf(hash)) !== undefined;
  }

  /**
   * Write bytes and return their hash.
   *
   * Writes to a temp file, fsyncs it, then renames into place. The rename is
   * atomic within a filesystem, so a crash mid-write can leave a stray temp
   * file but can never leave a half-written blob that something else would
   * later trust as complete content.
   */
  public async put(bytes: Uint8Array): Promise<Sha256Hex> {
    const hash = sha256Sync(bytes);
    if (await this.has(hash)) {
      return hash;
    }

    const finalPath = this.pathFor(hash);
    await mkdir(join(this.blobsDir, shardOf(hash)), { recursive: true });
    const tempPath = join(this.tmpDir, `${randomUUID()}.part`);

    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(tempPath, finalPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return hash;
  }

  public async get(hash: Sha256Hex): Promise<Uint8Array> {
    const handle = await open(this.pathFor(hash), "r");
    try {
      const buffer = await handle.readFile();
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } finally {
      await handle.close();
    }
  }

  public async sizeOf(hash: Sha256Hex): Promise<number | undefined> {
    try {
      return (await stat(this.pathFor(hash))).size;
    } catch {
      return undefined;
    }
  }

  public async delete(hash: Sha256Hex): Promise<void> {
    await rm(this.pathFor(hash), { force: true });
  }

  /**
   * Re-hash stored content and confirm it still matches its key.
   *
   * Not called on every read — that would double the cost of every transfer for
   * a check that only catches bit-rot. This exists for an explicit scrub.
   */
  public async verify(hash: Sha256Hex): Promise<boolean> {
    try {
      return sha256Sync(await this.get(hash)) === hash;
    } catch {
      return false;
    }
  }

  /** Remove temp files orphaned by a crash. Safe to call at startup. */
  public async sweepTemp(): Promise<void> {
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });
  }

  public pathFor(hash: Sha256Hex): string {
    assert(/^[a-f0-9]{64}$/u.test(hash), "blob key must be a sha256 hex digest");
    return join(this.blobsDir, shardOf(hash), `${hash}.kdbx`);
  }

  public get root(): string {
    return this.rootDir;
  }
}

function shardOf(hash: Sha256Hex): string {
  return hash.slice(0, 2);
}

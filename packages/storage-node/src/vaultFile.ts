import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "chokidar";
import { dirname, join } from "node:path";

/**
 * KeePassXC creates `<vault>.kdbx.lock` beside the vault while it has the
 * database open, and removes it on close. It is advisory, but respecting it is
 * the difference between cooperating with the password manager and fighting it.
 */
export function lockPathFor(vaultPath: string): string {
  return `${vaultPath}.lock`;
}

export async function isVaultLocked(vaultPath: string): Promise<boolean> {
  try {
    await stat(lockPathFor(vaultPath));
    return true;
  } catch {
    return false;
  }
}

export async function readVaultFile(vaultPath: string): Promise<Uint8Array> {
  const handle = await open(vaultPath, "r");
  try {
    const buffer = await handle.readFile();
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } finally {
    await handle.close();
  }
}

export type WriteOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "refused-locked"; readonly reason: string };

/**
 * Replace the user's vault file with new bytes, atomically.
 *
 * Temp file in the *same directory* — rename is only atomic within a
 * filesystem, and a temp directory can easily be on another one. Then fsync,
 * then rename, so a crash leaves either the old complete file or the new one,
 * never a half-written vault.
 *
 * Refuses outright while KeePassXC holds the vault open. Overwriting underneath
 * a running password manager risks it saving its own in-memory copy back over
 * ours moments later, silently discarding whatever we just merged.
 */
export async function writeVaultFileAtomic(input: {
  readonly vaultPath: string;
  readonly bytes: Uint8Array;
  /** Escape hatch for a user who has confirmed KeePassXC is actually closed. */
  readonly ignoreLock?: boolean;
}): Promise<WriteOutcome> {
  if (input.ignoreLock !== true && (await isVaultLocked(input.vaultPath))) {
    return {
      kind: "refused-locked",
      reason: "KeePassXC has this vault open. Close it before writing the merged revision."
    };
  }

  const directory = dirname(input.vaultPath);
  const tempPath = join(directory, `.passvault-${randomUUID()}.tmp`);

  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(
      Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
    );
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tempPath, input.vaultPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return { kind: "written" };
}

export interface VaultWatcherDeps {
  readonly vaultPath: string;
  /** Called with the file's contents once writing has settled. */
  readonly onChange: (bytes: Uint8Array) => Promise<void>;
  readonly onError?: (error: Error) => void;
  readonly debounceMs?: number;
}

/**
 * Watches the vault KeePassXC writes and reports settled content.
 *
 * Three things make this less trivial than "watch a file":
 *
 * A save is not one event. KeePassXC writes a temp file and renames it over the
 * vault, so a single save can surface as unlink-then-add rather than a change,
 * and often as several events in quick succession. Everything is debounced and
 * the file is read fresh afterwards.
 *
 * The lock file sits in the same directory and changes constantly during a
 * session; watching the vault path alone keeps it out of scope.
 *
 * A read can still lose a race with a rename, so a missing or unreadable file
 * is retried once rather than reported as an error.
 */
export class VaultFileWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;
  private pending = false;

  public constructor(private readonly deps: VaultWatcherDeps) {}

  public start(): void {
    if (this.watcher !== undefined) {
      return;
    }
    this.watcher = watch(this.deps.vaultPath, {
      ignoreInitial: true,
      // A rename-over arrives as add/unlink; awaitWriteFinish smooths the rest.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    });
    const schedule = (): void => this.schedule();
    this.watcher.on("add", schedule);
    this.watcher.on("change", schedule);
    this.watcher.on("unlink", schedule);
    this.watcher.on("error", (error) => this.deps.onError?.(toError(error)));
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.watcher?.close();
    this.watcher = undefined;
  }

  /** Read and report the current contents without waiting for an event. */
  public async pollNow(): Promise<void> {
    await this.deliver();
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.deliver();
    }, this.deps.debounceMs ?? 400);
  }

  private async deliver(): Promise<void> {
    if (this.processing) {
      // A save landed while we were still handling the previous one.
      this.pending = true;
      return;
    }
    this.processing = true;
    try {
      const bytes = await this.readWithRetry();
      if (bytes !== undefined) {
        await this.deps.onChange(bytes);
      }
    } catch (error) {
      this.deps.onError?.(toError(error));
    } finally {
      this.processing = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }

  private async readWithRetry(): Promise<Uint8Array | undefined> {
    try {
      return await readVaultFile(this.deps.vaultPath);
    } catch {
      // Most likely mid-rename. Give it a moment, then decide.
      await delay(120);
      try {
        return await readVaultFile(this.deps.vaultPath);
      } catch {
        return undefined;
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

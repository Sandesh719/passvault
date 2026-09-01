import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VaultFileWatcher,
  isVaultLocked,
  lockPathFor,
  readVaultFile,
  writeVaultFileAtomic
} from "./vaultFile.js";

let dir: string;
let vaultPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "keepass-vaultfile-"));
  vaultPath = join(dir, "Shared.kdbx");
  await writeFile(vaultPath, Buffer.from([1, 2, 3]));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("condition was not met in time"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("vault file writes", () => {
  it("replaces the file atomically and leaves no temp behind", async () => {
    const outcome = await writeVaultFileAtomic({
      vaultPath,
      bytes: new Uint8Array([9, 9, 9, 9])
    });

    expect(outcome.kind).toBe("written");
    expect(await readVaultFile(vaultPath)).toEqual(new Uint8Array([9, 9, 9, 9]));
    const leftovers = (await readdir(dir)).filter((name) => name.includes("passvault"));
    expect(leftovers).toEqual([]);
  });

  it("refuses to write while KeePassXC holds the vault open", async () => {
    await writeFile(lockPathFor(vaultPath), "");

    const outcome = await writeVaultFileAtomic({ vaultPath, bytes: new Uint8Array([7]) });

    // Overwriting underneath a running KeePassXC risks it saving its own
    // in-memory copy back over ours moments later.
    expect(outcome.kind).toBe("refused-locked");
    expect(await readVaultFile(vaultPath)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("writes anyway when the user confirms the lock is stale", async () => {
    await writeFile(lockPathFor(vaultPath), "");
    const outcome = await writeVaultFileAtomic({
      vaultPath,
      bytes: new Uint8Array([7]),
      ignoreLock: true
    });
    expect(outcome.kind).toBe("written");
  });

  it("detects the lock file", async () => {
    expect(await isVaultLocked(vaultPath)).toBe(false);
    await writeFile(lockPathFor(vaultPath), "");
    expect(await isVaultLocked(vaultPath)).toBe(true);
  });

  it("writes into the vault's own directory so the rename stays atomic", async () => {
    // A temp file on another filesystem would make rename a copy, which is not
    // atomic and can leave a partially written vault.
    let sawTempBesideVault = false;
    const probe = setInterval(() => {
      void readdir(dir).then((names) => {
        if (names.some((name) => name.startsWith(".passvault-"))) {
          sawTempBesideVault = true;
        }
      });
    }, 1);
    await writeVaultFileAtomic({ vaultPath, bytes: new Uint8Array(2 * 1024 * 1024) });
    clearInterval(probe);
    expect(sawTempBesideVault).toBe(true);
  });
});

describe("VaultFileWatcher", () => {
  it("reports contents after a plain save", async () => {
    const seen: Uint8Array[] = [];
    const watcher = new VaultFileWatcher({
      vaultPath,
      debounceMs: 50,
      onChange: async (bytes) => {
        seen.push(bytes);
      }
    });
    watcher.start();

    try {
      await writeFile(vaultPath, Buffer.from([4, 5, 6]));
      await waitFor(() => seen.length > 0);
      expect(seen[seen.length - 1]).toEqual(new Uint8Array([4, 5, 6]));
    } finally {
      await watcher.stop();
    }
  }, 20_000);

  it("reports contents after an atomic rename, the way KeePassXC saves", async () => {
    const seen: Uint8Array[] = [];
    const watcher = new VaultFileWatcher({
      vaultPath,
      debounceMs: 50,
      onChange: async (bytes) => {
        seen.push(bytes);
      }
    });
    watcher.start();

    try {
      // KeePassXC does not write in place; it writes a temp and renames over.
      const staging = join(dir, "staged.tmp");
      await writeFile(staging, Buffer.from([8, 8, 8, 8]));
      await rename(staging, vaultPath);

      await waitFor(() => seen.length > 0);
      expect(seen[seen.length - 1]).toEqual(new Uint8Array([8, 8, 8, 8]));
    } finally {
      await watcher.stop();
    }
  }, 20_000);

  it("collapses a burst of events into one report", async () => {
    let calls = 0;
    const watcher = new VaultFileWatcher({
      vaultPath,
      debounceMs: 150,
      onChange: async () => {
        calls += 1;
      }
    });
    watcher.start();

    try {
      for (let index = 0; index < 5; index += 1) {
        await writeFile(vaultPath, Buffer.from([index]));
      }
      await waitFor(() => calls > 0);
      await new Promise((resolve) => setTimeout(resolve, 600));
      // One settled save, not five revisions in the history.
      expect(calls).toBe(1);
    } finally {
      await watcher.stop();
    }
  }, 20_000);

  it("ignores the lock file appearing and disappearing", async () => {
    let calls = 0;
    const watcher = new VaultFileWatcher({
      vaultPath,
      debounceMs: 50,
      onChange: async () => {
        calls += 1;
      }
    });
    watcher.start();

    try {
      // Opening and closing KeePassXC must not manufacture revisions.
      await writeFile(lockPathFor(vaultPath), "");
      await new Promise((resolve) => setTimeout(resolve, 400));
      await rm(lockPathFor(vaultPath));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(calls).toBe(0);
    } finally {
      await watcher.stop();
    }
  }, 20_000);

  it("stops reporting once stopped", async () => {
    let calls = 0;
    const watcher = new VaultFileWatcher({
      vaultPath,
      debounceMs: 50,
      onChange: async () => {
        calls += 1;
      }
    });
    watcher.start();
    await watcher.stop();

    await writeFile(vaultPath, Buffer.from([1]));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toBe(0);
  }, 20_000);

  it("round-trips through a real write", async () => {
    await writeVaultFileAtomic({ vaultPath, bytes: new Uint8Array([3, 1, 4, 1, 5]) });
    expect(new Uint8Array(await readFile(vaultPath))).toEqual(new Uint8Array([3, 1, 4, 1, 5]));
  });
});

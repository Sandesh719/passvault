import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        await walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  await walk(dir);
  return found;
}

async function importsIn(file: string): Promise<readonly string[]> {
  const text = await readFile(file, "utf8");
  const code = text
    // Strip comments so prose describing a boundary does not trip the check on it.
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    // Type-only imports are erased before anything runs. They cannot open a
    // vault or reach a filesystem, so they are not boundary violations —
    // borrowing a type is not the same as gaining a capability.
    .replace(/^\s*import\s+type[\s\S]*?from\s+["'][^"']+["'];?/gmu, "");
  return [...code.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1] ?? "");
}

/**
 * The layering claims in the design are only true while they stay true. These
 * assert the two that carry security weight, so violating one fails the build
 * instead of quietly eroding.
 */
describe("architectural boundaries", () => {
  it("keeps decryption inside packages/kdbx", async () => {
    const offenders: string[] = [];
    for (const dir of ["packages", "apps"]) {
      for (const file of await sourceFiles(join(repoRoot, dir))) {
        if (file.includes(`packages${"/"}kdbx${"/"}`)) {
          continue;
        }
        if ((await importsIn(file)).some((specifier) => specifier === "kdbxweb")) {
          offenders.push(file.replace(repoRoot, ""));
        }
      }
    }
    expect(offenders, "only packages/kdbx may open a vault").toEqual([]);
  });

  it("keeps the filesystem out of the decryption boundary", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(repoRoot, "packages", "kdbx"))) {
      const forbidden = (await importsIn(file)).filter(
        (specifier) => specifier.startsWith("node:fs") || specifier.includes("storage-")
      );
      if (forbidden.length > 0) {
        offenders.push(`${file.replace(repoRoot, "")} -> ${forbidden.join(", ")}`);
      }
    }
    // With no filesystem reachable from here, decrypted material cannot be
    // written to disk from inside the one component that can produce it.
    expect(offenders, "packages/kdbx must not be able to touch disk").toEqual([]);
  });

  it("keeps the renderer out of the main process's resources", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(repoRoot, "apps", "desktop", "src", "renderer"))) {
      const forbidden = (await importsIn(file)).filter(
        (specifier) =>
          specifier.startsWith("node:") ||
          specifier === "electron" ||
          specifier.includes("storage-") ||
          specifier.includes("/identity") ||
          specifier.includes("/sync")
      );
      if (forbidden.length > 0) {
        offenders.push(`${file.replace(repoRoot, "")} -> ${forbidden.join(", ")}`);
      }
    }
    // The window runs UI and WebRTC. Everything else — the filesystem, the
    // database, the device private key — is reachable only through the
    // enumerated preload bridge, so a compromised renderer cannot touch it.
    expect(offenders, "the renderer must go through the preload bridge").toEqual([]);
  });

  it("keeps the sync engine free of platform dependencies", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(repoRoot, "packages", "sync"))) {
      const forbidden = (await importsIn(file)).filter(
        (specifier) =>
          specifier.startsWith("node:") ||
          specifier === "react" ||
          specifier === "kdbxweb" ||
          specifier.includes("storage-")
      );
      if (forbidden.length > 0) {
        offenders.push(`${file.replace(repoRoot, "")} -> ${forbidden.join(", ")}`);
      }
    }
    // The engine must run unchanged on Electron and Android; anything
    // platform-specific belongs behind a port.
    expect(offenders, "packages/sync must depend only on core ports").toEqual([]);
  });
});

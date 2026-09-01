#!/usr/bin/env node
/**
 * Launch a complete two-device setup on one machine.
 *
 * "Two devices" never meant two computers. Each Electron instance gets its own
 * profile directory, which means its own keypair, its own database, and its own
 * vault file — they are as separate as two laptops, and the only thing they
 * share is the loopback network they talk over.
 *
 * Starts the signaling server, creates two sample vaults, and opens two labelled
 * windows side by side. Ctrl-C stops everything.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = join(repoRoot, ".sandbox");

const PASSWORD = "demo";
const dim = (text) => `[2m${text}[0m`;
const bold = (text) => `[1m${text}[0m`;
const green = (text) => `[32m${text}[0m`;

const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
  children.push(child);
  return child;
}

async function waitForSignaling(url, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`signaling server did not come up at ${url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Two separate vault files, so each device has something of its own to track. */
async function createSampleVaults() {
  const kdbxweb = require("kdbxweb");
  const { argon2id, argon2d, argon2i } = require("hash-wasm");

  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type) => {
      const options = {
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        parallelism,
        iterations,
        memorySize: memory,
        hashLength: length,
        outputType: "binary"
      };
      const hash =
        type === kdbxweb.CryptoEngine.Argon2TypeArgon2d
          ? await argon2d(options)
          : type === kdbxweb.CryptoEngine.Argon2TypeArgon2id
            ? await argon2id(options)
            : await argon2i(options);
      return new Uint8Array(hash).buffer;
    }
  );

  const made = [];
  for (const name of ["Laptop", "Desktop"]) {
    const path = join(sandbox, `${name}.kdbx`);
    if (await exists(path)) {
      continue;
    }
    const credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromString(PASSWORD),
      null
    );
    const db = kdbxweb.Kdbx.create(credentials, "Shared");
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", "Bank");
    entry.fields.set("UserName", "vikas");
    entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("s3cret"));
    await writeFile(path, Buffer.from(await db.save()));
    made.push(path);
  }
  return made;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  console.log(dim("\nStopping…"));
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", stopAll);

async function main() {
  const fresh = process.argv.includes("--fresh");
  if (fresh) {
    await rm(sandbox, { recursive: true, force: true });
    console.log(dim("Cleared previous sandbox."));
  }
  await mkdir(sandbox, { recursive: true });

  console.log(`\n${bold("Starting a two-device setup on this machine")}\n`);

  run("pnpm", ["--filter", "@passvault/signaling", "dev"], { stdio: "ignore" });
  await waitForSignaling("http://localhost:8787/health");
  console.log(`${green("✓")} signaling server  ${dim("http://localhost:8787")}`);

  await createSampleVaults();
  console.log(`${green("✓")} sample vaults     ${dim(`${sandbox}/{Laptop,Desktop}.kdbx — password "${PASSWORD}"`)}`);

  const devices = [
    { label: "Laptop", x: 40, y: 60 },
    { label: "Desktop", x: 620, y: 160 }
  ];
  for (const device of devices) {
    run(
      "pnpm",
      [
        "--filter",
        "@passvault/desktop",
        "exec",
        "electron",
        ".",
        `--user-data-dir=${join(sandbox, `profile-${device.label}`)}`
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          PASSVAULT_DEVICE_LABEL: device.label,
          PASSVAULT_WINDOW_X: String(device.x),
          PASSVAULT_WINDOW_Y: String(device.y)
        }
      }
    );
    console.log(`${green("✓")} window            ${dim(device.label)}`);
  }

  console.log(`\n${bold("What to do")}`);
  console.log(
    `  1. On ${bold("Laptop")} only: "My password file is on this device" → ${dim(`${sandbox}/Laptop.kdbx`)}`
  );
  console.log(dim("     Leave Desktop alone — a vault is shared from one device and joined on the other."));
  console.log(`  2. ${bold("Laptop")} → Devices → "Get a code" ${dim("(eight characters, e.g. 4F7K-2QX9)")}`);
  console.log(`  3. ${bold("Desktop")} → Devices → type it → Connect`);
  console.log(`  4. Both windows stop on the same six digits. ${bold("Answer yes on each")} — the`);
  console.log(dim("     handshake genuinely waits, and nothing is shared until you do."));
  console.log(`  5. Edit a vault (any KeePass app, password "${PASSWORD}") and watch it reach the other window\n`);
  console.log(dim("  Ctrl-C stops everything. Re-run with --fresh to wipe both profiles.\n"));
}

main().catch((error) => {
  console.error(`\nFailed to start: ${error instanceof Error ? error.message : String(error)}`);
  stopAll();
  process.exit(1);
});

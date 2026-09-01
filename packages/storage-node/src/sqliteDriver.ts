import { createRequire } from "node:module";

/**
 * node-sqlite3-wasm ships CommonJS. Bundlers cope with a named import, but
 * Electron's ESM loader does not, so the module is required explicitly rather
 * than left to interop to guess.
 */
const { Database } = createRequire(import.meta.url)(
  "node-sqlite3-wasm"
) as typeof import("node-sqlite3-wasm");

/**
 * A minimal SQL surface over a WebAssembly build of SQLite.
 *
 * Why not a native binding: `better-sqlite3` compiles against a specific Node
 * ABI, and Electron ships its own. Making it work in the desktop app means
 * rebuilding it for Electron, which then breaks it for `node` — and the test
 * suite with it. With pnpm hard-linking one copy across the workspace there is
 * no version of that dance that leaves both working at once.
 *
 * A WebAssembly build sidesteps the whole problem and follows the choice
 * already made for Argon2 and Ed25519: one implementation, every runtime, no
 * build step. It also unblocks mobile later, where a native module is not an
 * option at all.
 *
 * The cost is real and worth stating: the WASM VFS does not support WAL, so the
 * database runs in rollback-journal mode. Writes are still atomic and crash-safe
 * — that is SQLite's classic default — but readers and writers do not overlap.
 * For a single-process desktop agent, nothing here notices.
 */
export interface SqlStatement {
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown[];
  run(...params: readonly unknown[]): void;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
}

type BindValue = string | number | bigint | Uint8Array | null;

/**
 * Accepts the calling conventions used across the store: a single object of
 * named parameters, or a run of positional ones.
 *
 * SQLite's `@name` placeholders require the binding keys to carry the sigil
 * too, so bare keys are prefixed here rather than at every call site.
 */
function normalize(params: readonly unknown[]): Record<string, BindValue> | BindValue[] | undefined {
  if (params.length === 0) {
    return undefined;
  }
  const [first] = params;
  const isNamed =
    params.length === 1 &&
    typeof first === "object" &&
    first !== null &&
    !Array.isArray(first) &&
    !(first instanceof Uint8Array);

  if (!isNamed) {
    return params.map(toBindValue);
  }

  const named: Record<string, BindValue> = {};
  for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
    named[key.startsWith("@") || key.startsWith(":") || key.startsWith("$") ? key : `@${key}`] =
      toBindValue(value);
  }
  return named;
}

function toBindValue(value: unknown): BindValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  return String(value);
}

export function openSqlite(filePath: string): SqlDatabase {
  const db = new Database(filePath);

  // Foreign keys are off by default in SQLite and must be enabled per
  // connection, not once per database file.
  db.exec("PRAGMA foreign_keys = ON");

  let closed = false;

  return {
    prepare: (sql: string): SqlStatement => ({
      get: (...params) => db.get(sql, normalize(params)) ?? undefined,
      all: (...params) => db.all(sql, normalize(params)),
      run: (...params) => {
        db.run(sql, normalize(params));
      }
    }),
    exec: (sql: string) => {
      db.exec(sql);
    },
    // Idempotent: the wasm build throws when closed twice, and shutdown paths
    // legitimately overlap (explicit close, then teardown on exit).
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    }
  };
}

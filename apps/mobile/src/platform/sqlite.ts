import type { SqlDatabase, SqlStatement } from "@passvault/core";
import initSqlJs, { type Database, type Statement } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

/**
 * SQLite inside the Android WebView.
 *
 * The obvious choice was the Capacitor SQLite plugin, which wraps the
 * platform's own native SQLite. It is asynchronous, and `SqlDatabase` is not —
 * deliberately, because both of the original implementations were, and an
 * async surface would force every caller to be written as though statements
 * might interleave when they cannot. Reaching for the plugin meant either
 * rewriting five hundred lines of shared SQL and its transaction handling, or
 * shipping a `get()` that throws.
 *
 * sql.js is a WebAssembly build with a synchronous API, so the shared stores
 * run here exactly as they do on the desktop — which itself reaches SQLite
 * through WebAssembly, so this is the same choice twice rather than a new one.
 *
 * The trade-off is persistence. sql.js holds the database in memory and hands
 * back the whole file on request, so durability is this module's job rather
 * than SQLite's:
 *
 *   - Every statement that can mutate marks the database dirty.
 *   - A commit flushes immediately; anything else flushes on a short debounce.
 *   - `flush()` is called when Android backgrounds the app.
 *
 * What that costs, stated plainly: a hard kill within the debounce window can
 * lose the last metadata write. Blobs are still written before metadata, so
 * the loss is a revision row whose bytes are already on disk — an orphaned
 * blob, which the design already treats as harmless. The reverse, a row
 * pointing at bytes that were never written, remains impossible.
 *
 * The database is metadata only — hashes, parent links, device keys — so it
 * stays small enough to rewrite whole. Vault bytes never come near it.
 */

const FLUSH_DEBOUNCE_MS = 150;

type BindValue = string | number | Uint8Array | null;

/** Mirrors the desktop driver, so the shared SQL binds identically on both. */
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
  if (typeof value === "string" || typeof value === "number" || value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return String(value);
}

export interface PersistentSqlDatabase extends SqlDatabase {
  /** Write the database out now. Called when the app goes to the background. */
  flush(): Promise<void>;
}

export interface SqliteHostFiles {
  read(): Promise<Uint8Array | undefined>;
  write(bytes: Uint8Array): Promise<void>;
}

export async function openWebSqlite(files: SqliteHostFiles): Promise<PersistentSqlDatabase> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const existing = await files.read();
  const db: Database = existing === undefined ? new SQL.Database() : new SQL.Database(existing);
  db.run("PRAGMA foreign_keys = ON");

  // Preparing a statement is not free and the stores issue the same handful of
  // them constantly, so they are kept and rebound rather than rebuilt.
  const cache = new Map<string, Statement>();
  const statementFor = (sql: string): Statement => {
    const held = cache.get(sql);
    if (held !== undefined) {
      held.reset();
      return held;
    }
    const made = db.prepare(sql);
    cache.set(sql, made);
    return made;
  };

  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) {
      return writing;
    }
    dirty = false;
    const bytes = db.export();
    writing = writing.then(() => files.write(bytes));
    return writing;
  };

  const touched = (sql: string): void => {
    dirty = true;
    // A commit is the one point the shared stores treat as durable, so it is
    // not left to the debounce.
    if (/^\s*(commit|rollback)/iu.test(sql)) {
      void flush();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, FLUSH_DEBOUNCE_MS);
    }
  };

  return {
    prepare: (sql: string): SqlStatement => ({
      get: (...params) => {
        const statement = statementFor(sql);
        const bound = normalize(params);
        if (bound !== undefined) {
          statement.bind(bound as never);
        }
        const row = statement.step() ? statement.getAsObject() : undefined;
        statement.reset();
        return row;
      },
      all: (...params) => {
        const statement = statementFor(sql);
        const bound = normalize(params);
        if (bound !== undefined) {
          statement.bind(bound as never);
        }
        const rows: unknown[] = [];
        while (statement.step()) {
          rows.push(statement.getAsObject());
        }
        statement.reset();
        return rows;
      },
      run: (...params) => {
        const statement = statementFor(sql);
        const bound = normalize(params);
        if (bound !== undefined) {
          statement.bind(bound as never);
        }
        statement.step();
        statement.reset();
        touched(sql);
      }
    }),
    exec: (sql: string) => {
      db.run(sql);
      touched(sql);
    },
    close: () => {
      for (const statement of cache.values()) {
        statement.free();
      }
      cache.clear();
      void flush().then(() => db.close());
    },
    flush
  };
}

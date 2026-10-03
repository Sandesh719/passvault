/**
 * The narrowest SQL surface the stores need.
 *
 * A port rather than a library type, for the same reason every other port here
 * exists: the metadata store is five hundred lines of SQL that say nothing
 * about which platform runs them. Expressing the database as an interface lets
 * that code be shared verbatim between the desktop app, which reaches SQLite
 * through a WebAssembly build under Node, and Android, which reaches it through
 * a Capacitor plugin — neither of which the SQL itself has any reason to know
 * about.
 *
 * Deliberately synchronous. Both implementations are, and an async surface
 * would force every caller to be written as though statements might interleave
 * when they cannot.
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

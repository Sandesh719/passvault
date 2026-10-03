/**
 * Everything that is stored in SQL, and nothing that knows which platform the
 * database is running on.
 *
 * The desktop app reaches SQLite through a WebAssembly build under Node and
 * Android reaches it through a Capacitor plugin; both hand an implementation of
 * core's `SqlDatabase` to the stores here, which are otherwise identical on the
 * two. Anything that touches a filesystem lives in `@passvault/storage-node`
 * instead, because a WebView has no filesystem to touch.
 */
export * from "./schema.js";
export * from "./settingsStore.js";
export * from "./sqliteMetadataStore.js";
export * from "./sqliteTrustStore.js";

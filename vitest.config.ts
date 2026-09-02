import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (name: string): string => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const app = (name: string): string => fileURLToPath(new URL(`./apps/${name}/src/index.ts`, import.meta.url));

/**
 * Tests resolve workspace packages to source, not to built output.
 *
 * Without this, a stale `dist` silently decides what the suite is testing.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@passvault/core": src("core"),
      "@passvault/kdbx": src("kdbx"),
      "@passvault/identity": src("identity"),
      "@passvault/sync": src("sync"),
      "@passvault/transport": src("transport"),
      "@passvault/storage-node": src("storage-node"),
      "@passvault/signaling": app("signaling"),
      // The main process reaches Electron for exactly one thing (safeStorage),
      // and that must not stop its logic being tested outside a window.
      electron: fileURLToPath(new URL("./tests/stubs/electron.ts", import.meta.url))
    }
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"]
  }
});

import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const here = import.meta.dirname;

const WORKSPACE_PACKAGES = [
  "@passvault/core",
  "@passvault/identity",
  "@passvault/kdbx",
  "@passvault/storage-node",
  "@passvault/sync",
  "@passvault/transport"
];

export default defineConfig({
  main: {
    // The workspace packages are bundled in rather than externalised: they are
    // this repository's own source, they do not exist on npm, and pnpm's
    // symlinked layout is exactly what a packager cannot follow. Everything
    // else — the real dependencies, including the two that carry wasm — stays
    // external and is collected from node_modules at packaging time.
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      outDir: resolve(here, "out/main"),
      rollupOptions: { input: resolve(here, "src/main/index.ts") }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      outDir: resolve(here, "out/preload"),
      rollupOptions: { input: resolve(here, "src/preload/index.ts") }
    }
  },
  renderer: {
    // The renderer's root is its own folder, so its outDir must be pinned
    // explicitly or it resolves relative to that root and lands outside the app.
    root: resolve(here, "src/renderer"),
    plugins: [react(), tailwind()],
    build: {
      outDir: resolve(here, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: { input: resolve(here, "src/renderer/index.html") }
    }
  }
});

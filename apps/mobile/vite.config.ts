import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  // Capacitor copies this directory into the Android assets, and the native
  // shell loads index.html from there.
  build: { outDir: "dist", emptyOutDir: true }
});

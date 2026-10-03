import { App, configureUi } from "@passvault/ui";
import "@passvault/ui/styles.css";
import { createRoot } from "react-dom/client";
// The same file electron-builder turns into the macOS and Windows icons, so
// the mark in the window can never drift from the one on the dock.
import logoUrl from "../../build/icon.png";
import type { DesktopApi } from "../shared/api.js";

declare global {
  interface Window {
    readonly passVault: DesktopApi;
  }
}

// One object answers both: the preload bridge carries the application surface
// and the transport half across the same IPC boundary.
configureUi({ api: window.passVault, host: window.passVault, logoUrl });

const root = document.querySelector("#root");
if (root !== null) {
  createRoot(root).render(<App />);
}

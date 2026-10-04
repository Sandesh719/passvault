/**
 * The interface, once, for every platform that runs it.
 *
 * Built against `VaultApi` rather than a transport, so the desktop can serve
 * it from the preload bridge and Android from the service object in the same
 * JavaScript context. The layout was already responsive down to a phone — that
 * work is what makes this reuse honest rather than a stretched desktop app.
 */
export { App, configureUi, pressBack } from "./App.js";
export * from "./ui.js";

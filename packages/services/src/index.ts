/**
 * What the application does, with no idea where it is running.
 *
 * This is the layer that used to be `DesktopServices`: pairing, running a
 * session, classifying what came back, writing the current version to disk,
 * and describing all of it to an interface. None of that differs between a
 * laptop and a phone, so none of it lives in either app any more — the few
 * things that do differ are in `platform.ts`.
 */
export * from "./api.js";
export * from "./platform.js";
export * from "./snapshot.js";
export * from "./vaultServices.js";

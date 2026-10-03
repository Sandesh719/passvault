import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The native shell.
 *
 * `androidScheme: https` matters beyond tidiness: it makes the WebView a
 * secure context, which is what gives the app `crypto.subtle` and WebRTC.
 * Served over `http` the vault could not be opened and no peer could be
 * reached, and both would fail at runtime rather than at build time.
 */
const config: CapacitorConfig = {
  appId: "org.passvault.app",
  appName: "PassVault",
  webDir: "dist",
  android: {
    // The app is the whole screen; the interface already handles its own
    // insets through the viewport-fit meta.
    backgroundColor: "#0e1117"
  },
  server: {
    androidScheme: "https"
  }
};

export default config;

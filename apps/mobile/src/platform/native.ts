import { registerPlugin } from "@capacitor/core";

/**
 * The two things Android will not let a WebView do.
 *
 * **Picking a file the user can see.** An app's private storage is invisible
 * to everything else, so a vault kept there could never be opened by KeePassDX
 * — which defeats the point. The Storage Access Framework is the only way to
 * hold a file that lives in the user's own Documents (or Drive, or anywhere
 * else a document provider exposes) and keep access to it across restarts.
 * That needs `takePersistableUriPermission`, which has no web API.
 *
 * **Protecting the device key.** The private key is this device's identity:
 * losing it means pairing again, and leaking it means another machine can
 * impersonate this one. App-private storage keeps other apps out, but the file
 * is still plaintext to anything that can read the data directory. The Android
 * Keystore holds a key the app can use and cannot export, which is the same
 * guarantee Electron's safeStorage gives on the desktop.
 */
export interface PassVaultNative {
  /**
   * Open the system picker so the user chooses an existing `.kdbx`, and take a
   * lasting grant on whatever they choose.
   */
  pickVault(): Promise<PickedVault>;
  /** Ask the user where to put a vault that arrived from another device. */
  createVault(options: { readonly suggestedName: string }): Promise<PickedVault>;
  readVault(options: { readonly uri: string }): Promise<{ readonly data: string }>;
  writeVault(options: { readonly uri: string; readonly data: string }): Promise<void>;
  /** Grants can be revoked, and a stale one should say so rather than throw. */
  hasAccess(options: { readonly uri: string }): Promise<{ readonly granted: boolean }>;

  /**
   * How much room the status bar, navigation bar and camera cutout take, in
   * CSS pixels. Android's WebView leaves `env(safe-area-inset-*)` at zero, so
   * this is the only way to find out.
   */
  insets(): Promise<SafeAreaInsets>;

  /** Is a hardware-or-OS-backed key available to wrap secrets with? */
  canProtect(): Promise<{ readonly available: boolean }>;
  protect(options: { readonly plaintext: string }): Promise<{ readonly ciphertext: string }>;
  unprotect(options: { readonly ciphertext: string }): Promise<{ readonly plaintext: string }>;
}

export type PickedVault =
  | { readonly cancelled: true }
  | {
      readonly cancelled?: false;
      /** A content URI. Opaque above this layer — never parsed as a path. */
      readonly uri: string;
      /** What the document provider calls it, which is what a person recognises. */
      readonly name: string;
    };

export interface SafeAreaInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export const Native = registerPlugin<PassVaultNative>("PassVaultNative");

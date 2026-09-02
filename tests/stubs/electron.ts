/**
 * Just enough Electron for the main process to run under a test runner.
 *
 * Only `safeStorage` is ever reached from `DesktopServices`; everything that
 * touches windows, menus or IPC lives in `main/index.ts`, which the tests do
 * not load. Keeping this stub tiny is a check in itself — if it ever needs to
 * grow, something has leaked out of the process boundary it belongs behind.
 */
export const safeStorage = {
  /**
   * No keychain, which is a real configuration (a headless Linux box) and the
   * weaker of the two paths: the private key is written to disk unencrypted
   * and only file permissions protect it. Testing that path is what makes the
   * permission assertion meaningful.
   */
  isEncryptionAvailable: (): boolean => false,
  encryptString: (value: string): Buffer => Buffer.from(value, "utf8"),
  decryptString: (buffer: Buffer): string => buffer.toString("utf8")
};

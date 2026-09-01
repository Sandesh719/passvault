import {
  fromHex,
  generateDeviceKeyPair,
  keyPairFromPrivateKey,
  toHex,
  type DeviceKeyPair
} from "@passvault/identity";
import { safeStorage } from "electron";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

interface StoredIdentity {
  readonly version: 1;
  readonly name: string;
  /** Hex private key, encrypted when the OS keychain is available. */
  readonly privateKey: string;
  readonly encrypted: boolean;
}

export interface LoadedIdentity {
  readonly keyPair: DeviceKeyPair;
  readonly name: string;
  /**
   * True when the key is only obfuscated by file permissions.
   *
   * Surfaced rather than hidden: the user should know if their device key is
   * sitting in plaintext because no keychain was available.
   */
  readonly atRestUnprotected: boolean;
}

/**
 * Loads this device's long-lived key, creating it on first run.
 *
 * The private key is the device's identity — losing it means re-pairing, and
 * leaking it means another machine can impersonate this one. It is encrypted
 * with the OS keychain via Electron's safeStorage where that works, and written
 * with owner-only permissions either way.
 *
 * It is deliberately kept out of the metadata database: that file is a sync
 * artifact that may one day be backed up or copied between machines, and a
 * device key must never travel with it.
 */
export async function loadOrCreateIdentity(appDataDir: string): Promise<LoadedIdentity> {
  const path = join(appDataDir, "device-identity.json");

  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as StoredIdentity;
    const privateKey = stored.encrypted
      ? fromHex(safeStorage.decryptString(Buffer.from(stored.privateKey, "base64")))
      : fromHex(stored.privateKey);
    return {
      keyPair: keyPairFromPrivateKey(privateKey),
      name: stored.name,
      atRestUnprotected: !stored.encrypted
    };
  } catch {
    // Nothing readable there yet; mint a new identity below.
  }

  const keyPair = generateDeviceKeyPair();
  const name = defaultDeviceName();
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const stored: StoredIdentity = {
    version: 1,
    name,
    privateKey: canEncrypt
      ? safeStorage.encryptString(toHex(keyPair.privateKey)).toString("base64")
      : toHex(keyPair.privateKey),
    encrypted: canEncrypt
  };

  await writeFile(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);

  return { keyPair, name, atRestUnprotected: !canEncrypt };
}

function defaultDeviceName(): string {
  // Two instances on one machine share a hostname, which makes them
  // indistinguishable in the pairing list. The launcher supplies a label.
  const label = process.env["PASSVAULT_DEVICE_LABEL"];
  if (label !== undefined && label.trim().length > 0) {
    return label.trim();
  }
  const host = hostname().replace(/\.local$/u, "");
  return host.length > 0 ? host : "This device";
}

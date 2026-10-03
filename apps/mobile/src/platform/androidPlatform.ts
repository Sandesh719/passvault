import { Device } from "@capacitor/device";
import type { DeviceStore, LoadedIdentity, Platform, VaultFileAccess } from "@passvault/services";
import {
  fromHex,
  generateDeviceKeyPair,
  keyPairFromPrivateKey,
  toHex
} from "@passvault/identity";
import { SqliteMetadataStore } from "@passvault/storage-sql";
import {
  AppBlobStore,
  readAppFile,
  readAppText,
  webHashPort,
  writeAppFileAtomic,
  writeAppText
} from "./appStorage.js";
import { Native } from "./native.js";
import { openWebSqlite, type PersistentSqlDatabase } from "./sqlite.js";

const DB_PATH = "metadata.db";
const IDENTITY_PATH = "device-identity.json";

interface StoredIdentity {
  readonly version: 1;
  readonly name: string;
  /** Hex private key, wrapped by the Android Keystore where one is available. */
  readonly privateKey: string;
  readonly encrypted: boolean;
}

/**
 * The vault file, wherever the user put it.
 *
 * A "path" here is a content URI held by a persisted permission grant, and it
 * is only ever passed back to the native layer — never taken apart. That is
 * what lets the same service code address a file on a laptop and a document on
 * a phone without knowing which it has.
 */
const androidFiles: VaultFileAccess = {
  read: async (path) => {
    const result = await Native.readVault({ uri: path });
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  },

  write: async (input) => {
    if (!(await Native.hasAccess({ uri: input.path })).granted) {
      // A grant the user revoked, or a document provider that went away. Both
      // need them to pick the file again, and neither is a write failure.
      return {
        kind: "refused-locked",
        reason: "PassVault no longer has permission to that file. Choose it again under Home."
      };
    }
    let binary = "";
    const step = 0x8000;
    for (let index = 0; index < input.bytes.length; index += step) {
      binary += String.fromCharCode(...input.bytes.subarray(index, index + step));
    }
    await Native.writeVault({ uri: input.path, data: btoa(binary) });
    return { kind: "written" };
  },

  /**
   * Always false, and correctly so.
   *
   * KeePassXC signals "I have this open" with a lock file beside the vault.
   * Android has no equivalent — a document provider hands one app the file at
   * a time and there is nothing to inspect — so there is no state here to
   * report. Answering true would hold back every update forever.
   */
  isLocked: async () => false

  // `watch` is deliberately absent: Android reports nothing about a document
  // the user picked. The app re-reads on resume instead, which is wired up in
  // main.tsx.
};

async function defaultDeviceName(): Promise<string> {
  try {
    const info = await Device.getInfo();
    // "Pixel 7" reads better in the other device's list than "Android device".
    return [info.manufacturer, info.model].filter(Boolean).join(" ").trim() || "Android device";
  } catch {
    return "Android device";
  }
}

/**
 * Load this device's long-lived key, creating it on first run.
 *
 * Wrapped with a Keystore-held key where the platform offers one, which is the
 * same bargain the desktop strikes with the OS keychain: the app can use the
 * key and cannot export it. Where it is not available the key is stored in the
 * clear in app-private storage and the app says so, rather than implying a
 * protection it does not have.
 */
async function loadIdentity(): Promise<LoadedIdentity> {
  const raw = await readAppText(IDENTITY_PATH);
  if (raw !== undefined) {
    try {
      const stored = JSON.parse(raw) as StoredIdentity;
      const hex = stored.encrypted
        ? (await Native.unprotect({ ciphertext: stored.privateKey })).plaintext
        : stored.privateKey;
      return {
        keyPair: keyPairFromPrivateKey(fromHex(hex)),
        name: stored.name,
        atRestUnprotected: !stored.encrypted
      };
    } catch {
      // Unreadable: fall through and mint a new identity. Pairing again is
      // recoverable; refusing to start is not.
    }
  }

  const keyPair = generateDeviceKeyPair();
  const name = await defaultDeviceName();
  const canProtect = (await Native.canProtect().catch(() => ({ available: false }))).available;
  const hex = toHex(keyPair.privateKey);
  const stored: StoredIdentity = {
    version: 1,
    name,
    privateKey: canProtect ? (await Native.protect({ plaintext: hex })).ciphertext : hex,
    encrypted: canProtect
  };
  await writeAppText(IDENTITY_PATH, JSON.stringify(stored));
  return { keyPair, name, atRestUnprotected: !canProtect };
}

/** Held so the app can force a write when Android backgrounds it. */
let database: PersistentSqlDatabase | undefined;

export async function flushDatabase(): Promise<void> {
  await database?.flush();
}

export const androidPlatform: Platform = {
  openStore: async (): Promise<DeviceStore> => {
    const db = await openWebSqlite({
      read: () => readAppFile(DB_PATH),
      write: (bytes) => writeAppFileAtomic(DB_PATH, bytes)
    });
    database = db;
    const metadata = new SqliteMetadataStore(db);
    return {
      blobs: new AppBlobStore(),
      metadata,
      hash: webHashPort,
      close: () => metadata.close()
    };
  },
  loadIdentity,
  files: androidFiles
};

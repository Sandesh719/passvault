import type { BlobStore, HashPort, MetadataStore, SqlDatabase } from "@passvault/core";
import type { DeviceKeyPair } from "@passvault/identity";

/**
 * The handful of things that genuinely differ between a laptop and a phone.
 *
 * Everything else the application does — pairing, divergence, conflicts,
 * writing the current version back — turned out not to care. These are what was
 * left after taking the Node and Electron imports out of the service layer, and
 * the list being this short is the whole reason an Android build is adapters
 * rather than a rewrite.
 */

export type VaultWriteOutcome =
  | { readonly kind: "written" }
  /** Another application has the file open and would overwrite what we wrote. */
  | { readonly kind: "refused-locked"; readonly reason: string };

export interface FileWatch {
  stop(): Promise<void>;
}

/**
 * Reading and writing the one file the password manager opens.
 *
 * A "path" here is whatever the platform uses to name that file for as long as
 * the app is allowed to touch it: an absolute path on a desktop, a content URI
 * held by a persisted permission grant on Android. Nothing above this interface
 * takes it apart, which is what lets the two coexist.
 */
export interface VaultFileAccess {
  read(path: string): Promise<Uint8Array>;
  write(input: {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly ignoreLock?: boolean;
  }): Promise<VaultWriteOutcome>;
  /**
   * Is another application holding the file open?
   *
   * Desktop KeePassXC says so with a lock file beside the vault. Android has no
   * equivalent and no way to ask, so there it is always false — which is sound,
   * because Android hands an app the whole file rather than letting two write
   * to it at once.
   */
  isLocked(path: string): Promise<boolean>;
  /**
   * Report changes to the file as they settle.
   *
   * Absent where the platform cannot watch. Android gives no change
   * notifications for a document the user picked, so the file is re-read when
   * the app comes back to the foreground instead.
   */
  watch?(input: {
    readonly path: string;
    readonly onChange: (bytes: Uint8Array) => Promise<void>;
    readonly onError: (error: Error) => void;
  }): FileWatch;
  /** What to call this file on screen; a content URI is not readable as a path. */
  displayName(path: string): string;
}

export interface LoadedIdentity {
  readonly keyPair: DeviceKeyPair;
  readonly name: string;
  /**
   * True when the key is protected by file permissions alone.
   *
   * Surfaced rather than hidden: someone whose device key is sitting in the
   * clear because no keystore was available should be told so.
   */
  readonly atRestUnprotected: boolean;
}

/**
 * Durable local storage for one device.
 *
 * `connection` is here because several small tables — device trust, where to
 * meet a peer again, preferences — are plain SQL that both platforms share.
 */
export interface DeviceStore {
  readonly blobs: BlobStore;
  readonly metadata: MetadataStore & { readonly connection: SqlDatabase };
  readonly hash: HashPort;
  close(): void;
}

export interface Platform {
  openStore(): Promise<DeviceStore>;
  loadIdentity(): Promise<LoadedIdentity>;
  readonly files: VaultFileAccess;
}

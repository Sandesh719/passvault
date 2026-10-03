import type { DeviceStore, FileWatch, LoadedIdentity, Platform } from "@passvault/services";
import {
  VaultFileWatcher,
  isVaultLocked,
  openLocalStore,
  readVaultFile,
  writeVaultFileAtomic
} from "@passvault/storage-node";
import { basename } from "node:path";
import { loadOrCreateIdentity } from "./identityStore.js";

/**
 * The desktop's answers to the few questions the service layer cannot answer
 * for itself.
 *
 * Every one of these is a straight call into the Node storage package. The
 * adapter earns its place by being the only file in the main process that
 * knows a vault is a path on a filesystem — which is what lets the same
 * service layer run on Android, where it is not.
 */
export function nodePlatform(appDataDir: string): Platform {
  return {
    openStore: async (): Promise<DeviceStore> => openLocalStore(appDataDir),
    loadIdentity: async (): Promise<LoadedIdentity> => loadOrCreateIdentity(appDataDir),
    files: {
      read: readVaultFile,
      write: async (input) =>
        writeVaultFileAtomic({
          vaultPath: input.path,
          bytes: input.bytes,
          ...(input.ignoreLock === undefined ? {} : { ignoreLock: input.ignoreLock })
        }),
      isLocked: isVaultLocked,
      watch: (input): FileWatch => {
        const watcher = new VaultFileWatcher({
          vaultPath: input.path,
          onChange: input.onChange,
          onError: input.onError
        });
        watcher.start();
        return { stop: () => watcher.stop() };
      },
      displayName: (path) => basename(path)
    }
  };
}

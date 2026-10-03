import type {
  AppSnapshot,
  VaultApi,
  VaultServices,
  WriteBackOutcome
} from "@passvault/services";
import { Native } from "./platform/native.js";

/**
 * The application surface, answered in this process.
 *
 * On the desktop every one of these crosses IPC, because the engine must not
 * be reachable from a window running web content. A phone has one process and
 * one WebView, so the same calls are ordinary method calls — the interface
 * above cannot tell, which is why it is the same interface.
 *
 * Only two methods differ in substance, and both for the same reason: picking a
 * file is a system dialogue, and Android's is the Storage Access Framework
 * rather than a path chooser.
 */
export function createMobileApi(input: {
  readonly services: VaultServices;
  readonly onSnapshot: (listener: (snapshot: AppSnapshot) => void) => () => void;
  readonly onSyncSuggested: (listener: () => void) => () => void;
}): VaultApi {
  const { services } = input;

  return {
    getSnapshot: () => services.snapshot(),
    onSnapshot: input.onSnapshot,
    onSyncSuggested: input.onSyncSuggested,

    chooseVault: async (): Promise<AppSnapshot> => {
      const picked = await Native.pickVault();
      if (picked.cancelled === true) {
        return services.snapshot();
      }
      // The document provider's own name, not a guess from the URI.
      await services.bindVault(picked.uri, picked.name);
      return services.snapshot();
    },

    stopTrackingVault: async (): Promise<AppSnapshot> => {
      await services.stopTrackingVault();
      return services.snapshot();
    },

    saveVaultAs: async (): Promise<WriteBackOutcome> => {
      const snapshot = await services.snapshot();
      const suggested = snapshot.vault?.name ?? "Shared.kdbx";
      const picked = await Native.createVault({ suggestedName: suggested });
      if (picked.cancelled === true) {
        return { kind: "failed", reason: "Cancelled." };
      }
      return services.saveVaultAs(picked.uri);
    },

    restoreVersion: async (versionId: string): Promise<AppSnapshot> => {
      await services.promote(versionId);
      return services.snapshot();
    },
    applyPendingUpdate: () => services.applyPendingUpdate(),

    connectionSettings: async () => services.connectionSettings(),
    saveConnectionSettings: async (next) => services.saveConnectionSettings(next),
    testConnectionServer: (host) => services.testConnectionServer(host),
    iceServers: async () => services.iceServers(),

    createPairingCode: () => services.createPairingCode(),
    readPairingCode: (code) => services.readPairingCode(code),
    shortAuthenticationString: async (publicKeyBase64) => services.sasFor(publicKeyBase64),
    answerVerification: (confirmed) => {
      services.answerVerification(confirmed);
    },

    disconnectDevice: async (deviceId) => {
      await services.disconnectDevice(deviceId);
      return services.snapshot();
    },
    reconnectDevice: async (deviceId) => {
      await services.reconnectDevice(deviceId);
      return services.snapshot();
    },
    forgetDevice: async (deviceId) => {
      await services.forgetDevice(deviceId);
      return services.snapshot();
    },

    rendezvousFor: async (deviceId) => {
      const where = services.rendezvousFor(deviceId);
      if (where === undefined) {
        return { error: "This device was paired before reconnect was supported. Pair it again." };
      }
      const peer = (await services.snapshot()).pairedDevices.find((d) => d.deviceId === deviceId);
      return { ...where, peerName: peer?.name ?? "the paired device" };
    },
    standingRendezvous: async () => {
      const standing = services.standingRendezvous();
      return standing === undefined
        ? undefined
        : {
            roomId: standing.roomId,
            inviteToken: standing.inviteToken,
            signalUrl: standing.signalUrl,
            peerName: standing.name
          };
    },

    runSession: (request) => services.runSession(request.peerId, request.pairingMode),

    previewMerge: (request) => services.previewMerge({ ...request }),
    merge: (request) => services.merge({ ...request }),
    combineAndUse: (request) => services.combineAndUse({ ...request }),
    resolveConflict: async (request) => {
      await services.resolveConflict(request.conflictId, request.decision);
      return services.snapshot();
    }
  };
}

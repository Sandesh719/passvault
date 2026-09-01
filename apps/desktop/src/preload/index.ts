import { contextBridge, ipcRenderer } from "electron";
import type { AppSnapshot, DesktopApi, IceServer, PeerFrame } from "../shared/api.js";

/**
 * The entire surface the renderer is allowed to touch.
 *
 * Nothing here forwards an arbitrary channel name or an arbitrary path: each
 * method is a specific, named capability. A renderer compromised by hostile web
 * content can call exactly these and nothing else — in particular it cannot
 * read a file, open the database, or reach the device private key.
 */
const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke("snapshot:get") as Promise<AppSnapshot>,

  onSnapshot: (listener) => {
    const handler = (_event: unknown, snapshot: AppSnapshot): void => listener(snapshot);
    ipcRenderer.on("snapshot", handler);
    return () => ipcRenderer.removeListener("snapshot", handler);
  },

  onSyncSuggested: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on("sync:suggested", handler);
    return () => ipcRenderer.removeListener("sync:suggested", handler);
  },

  chooseVault: () => ipcRenderer.invoke("vault:choose") as Promise<AppSnapshot>,
  saveVaultAs: () => ipcRenderer.invoke("vault:saveAs"),
  restoreVersion: (versionId) =>
    ipcRenderer.invoke("version:restore", versionId) as Promise<AppSnapshot>,
  applyPendingUpdate: () => ipcRenderer.invoke("vault:applyPending"),

  connectionSettings: () => ipcRenderer.invoke("settings:get"),
  saveConnectionSettings: (next) => ipcRenderer.invoke("settings:save", next),
  testConnectionServer: (host) => ipcRenderer.invoke("settings:test", host),
  iceServers: () => ipcRenderer.invoke("settings:ice") as Promise<IceServer[]>,

  createPairingCode: () => ipcRenderer.invoke("pairing:create"),
  readPairingCode: (code) => ipcRenderer.invoke("pairing:read", code),
  shortAuthenticationString: (publicKeyBase64) =>
    ipcRenderer.invoke("pairing:sas", publicKeyBase64) as Promise<string>,
  answerVerification: (confirmed) => ipcRenderer.send("pairing:answer", confirmed),
  disconnectDevice: (deviceId) =>
    ipcRenderer.invoke("device:disconnect", deviceId) as Promise<AppSnapshot>,
  reconnectDevice: (deviceId) =>
    ipcRenderer.invoke("device:reconnect", deviceId) as Promise<AppSnapshot>,
  forgetDevice: (deviceId) => ipcRenderer.invoke("device:forget", deviceId) as Promise<AppSnapshot>,
  rendezvousFor: (deviceId) => ipcRenderer.invoke("rendezvous:for", deviceId),
  standingRendezvous: () => ipcRenderer.invoke("rendezvous:standing"),

  runSession: (input) => ipcRenderer.invoke("session:run", input),
  peerInbound: (frame) => ipcRenderer.send("peer:inbound", frame),
  peerBuffered: (peerId, bytes) => ipcRenderer.send("peer:buffered", peerId, bytes),
  peerClosed: (peerId) => ipcRenderer.send("peer:closed", peerId),
  onPeerOutbound: (listener) => {
    const handler = (_event: unknown, frame: PeerFrame): void => listener(frame);
    ipcRenderer.on("peer:outbound", handler);
    return () => ipcRenderer.removeListener("peer:outbound", handler);
  },

  previewMerge: (input) => ipcRenderer.invoke("merge:preview", input),
  merge: (input) => ipcRenderer.invoke("merge:run", input),
  combineAndUse: (input) => ipcRenderer.invoke("merge:combineAndUse", input),
  resolveConflict: (input) => ipcRenderer.invoke("conflict:resolve", input) as Promise<AppSnapshot>
};

contextBridge.exposeInMainWorld("passVault", api);

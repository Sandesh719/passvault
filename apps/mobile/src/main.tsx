import { App as CapacitorApp } from "@capacitor/app";
import { VaultServices, type AppSnapshot } from "@passvault/services";
import { type PeerFrame, type PeerTransportHost } from "@passvault/transport";
import { App, configureUi } from "@passvault/ui";
import "@passvault/ui/styles.css";
import { createRoot } from "react-dom/client";
import { createMobileApi } from "./api.js";
import logoUrl from "./icon.png";
import { androidPlatform, flushDatabase } from "./platform/androidPlatform.js";

/**
 * Starting the app on a phone.
 *
 * The desktop does this across two processes: the main process owns the engine
 * and the renderer owns WebRTC, with the preload bridge between them. Here
 * there is one JavaScript context, so the same two halves are joined by a
 * function call — the link hub's frames go straight to the bridge instead of
 * across IPC, and the bridge's frames straight back.
 *
 * Everything else is the code the desktop already runs.
 */

const DEFAULT_SERVER_HOST = "passvault-sandy.duckdns.org";

const snapshotListeners = new Set<(snapshot: AppSnapshot) => void>();
const syncListeners = new Set<() => void>();

const services = new VaultServices({
  platform: androidPlatform,
  defaultServerHost: DEFAULT_SERVER_HOST,
  emitPeerFrame: (frame) => {
    outbound?.(frame);
  },
  onSnapshotChanged: () => {
    void services.snapshot().then((snapshot) => {
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    });
  },
  onSyncSuggested: () => {
    for (const listener of syncListeners) {
      listener();
    }
  }
});

/**
 * The transport host, satisfied in memory.
 *
 * The desktop's implementation of these five methods is five IPC sends. Here
 * they are the hub's own methods, which is the whole difference between the
 * platforms at this layer.
 */
let outbound: ((frame: PeerFrame) => void) | undefined;

const host: PeerTransportHost = {
  peerInbound: (frame) => services.peers.deliverInbound(frame),
  peerBuffered: (peerId, bytes) => services.peers.reportBuffered(peerId, bytes),
  peerOpen: (peerId) => services.peerOpened(peerId),
  peerClosed: (peerId) => {
    services.peerGone(peerId);
    services.peers.closeLink(peerId);
  },
  onPeerOutbound: (listener) => {
    outbound = listener;
    return () => {
      outbound = undefined;
    };
  }
};

const api = createMobileApi({
  services,
  onSnapshot: (listener) => {
    snapshotListeners.add(listener);
    return () => snapshotListeners.delete(listener);
  },
  onSyncSuggested: (listener) => {
    syncListeners.add(listener);
    return () => syncListeners.delete(listener);
  }
});

async function start(): Promise<void> {
  await services.start();

  /**
   * Android gives no notification when another app writes the vault, so the
   * moment the user comes back to PassVault is the moment to look. The desktop
   * learns the same thing from a file watcher; this is the same work on a
   * different trigger.
   *
   * Going the other way, the database is written out before Android is free to
   * kill the process.
   */
  void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      void services.recordFileNow();
    } else {
      void flushDatabase();
    }
  });

  configureUi({ api, host, logoUrl });
  const root = document.querySelector("#root");
  if (root !== null) {
    createRoot(root).render(<App />);
  }
}

void start();

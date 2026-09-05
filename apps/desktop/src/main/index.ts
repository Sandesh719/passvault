import { BrowserWindow, app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectionSettings, PeerFrame } from "../shared/api.js";
import { DesktopServices } from "./services.js";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * The server to meet peers on, until the user picks one.
 *
 * A working default rather than `localhost`, which was only ever right for
 * someone running the server on the same machine — a fresh install on a second
 * device found nothing there and had to be configured before it could do
 * anything at all.
 *
 * Overridden per device under Devices → Connection server, which is what
 * anyone running their own server or a relay will use. `PASSVAULT_SIGNAL_HOST`
 * overrides it at launch, which is how `pnpm two` keeps development on
 * loopback.
 */
const DEFAULT_SERVER_HOST = process.env["PASSVAULT_SIGNAL_HOST"] ?? "passvault-sandy.duckdns.org";

let window: BrowserWindow | undefined;
let services: DesktopServices | undefined;

function emitToRenderer(channel: string, payload: unknown): void {
  if (window !== undefined && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

async function pushSnapshot(): Promise<void> {
  if (services === undefined) {
    return;
  }
  emitToRenderer("snapshot", await services.snapshot());
}

function createWindow(): void {
  // Two instances on one machine are two devices, and they must be tellable
  // apart on screen or pairing becomes guesswork about which window is which.
  const label = process.env["PASSVAULT_DEVICE_LABEL"];
  const x = Number.parseInt(process.env["PASSVAULT_WINDOW_X"] ?? "", 10);
  const y = Number.parseInt(process.env["PASSVAULT_WINDOW_Y"] ?? "", 10);

  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    ...(Number.isInteger(x) && Number.isInteger(y) ? { x, y } : {}),
    title: label === undefined ? "PassVault" : `PassVault — ${label}`,
    // Matches --color-ground, so the frame does not flash the old teal before
    // the renderer paints.
    backgroundColor: "#0e1117",
    webPreferences: {
      preload: join(here, "../preload/index.mjs"),
      // The renderer runs UI and WebRTC and nothing else. It gets no Node
      // integration and no direct reach into the main process; everything it
      // may do is enumerated in the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"] !== undefined) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(here, "../renderer/index.html"));
  }
}

/**
 * Startup failures must be visible.
 *
 * A rejected promise inside `whenReady` leaves a window open in front of a
 * process that never finished starting, which reads as "the app is fine" when
 * it is not.
 */
function fatal(stage: string, error: unknown): never {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[passvault] ${stage} failed:\n${detail}`);
  dialog.showErrorBox("PassVault could not start", `${stage} failed.\n\n${detail}`);
  app.exit(1);
  throw error;
}

app.whenReady().then(async () => {
  console.log(`[passvault] user data: ${app.getPath("userData")}`);
  services = new DesktopServices({
    appDataDir: app.getPath("userData"),
    defaultServerHost: DEFAULT_SERVER_HOST,
    emitPeerFrame: (frame: PeerFrame) => emitToRenderer("peer:outbound", frame),
    onSnapshotChanged: () => {
      void pushSnapshot();
    },
    onSyncSuggested: () => emitToRenderer("sync:suggested", undefined)
  });
  try {
    await services.start();
  } catch (error) {
    fatal("Opening the local store", error);
  }

  registerHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[passvault] unhandled rejection:", reason);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void services?.stop();
});

function requireServices(): DesktopServices {
  if (services === undefined) {
    throw new Error("The application is still starting.");
  }
  return services;
}

function registerHandlers(): void {
  ipcMain.handle("snapshot:get", async () => requireServices().snapshot());

  ipcMain.handle("vault:choose", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose the .kdbx vault KeePassXC opens",
      properties: ["openFile"],
      filters: [{ name: "KeePass database", extensions: ["kdbx"] }]
    });
    const path = result.filePaths[0];
    if (!result.canceled && path !== undefined) {
      await requireServices().bindVault(path);
    }
    return requireServices().snapshot();
  });

  ipcMain.handle("vault:saveAs", async () => {
    const result = await dialog.showSaveDialog({
      title: "Save the shared vault",
      defaultPath: "Shared.kdbx",
      filters: [{ name: "KeePass database", extensions: ["kdbx"] }]
    });
    if (result.canceled || result.filePath === undefined) {
      return { kind: "failed", reason: "Cancelled." };
    }
    return requireServices().saveVaultAs(result.filePath);
  });

  ipcMain.handle("vault:stopTracking", async () => {
    await requireServices().stopTrackingVault();
    return requireServices().snapshot();
  });

  ipcMain.handle("vault:applyPending", async () => requireServices().applyPendingUpdate());

  ipcMain.handle("version:restore", async (_event, versionId: string) => {
    await requireServices().promote(versionId);
    return requireServices().snapshot();
  });

  ipcMain.handle("settings:get", async () => requireServices().connectionSettings());
  ipcMain.handle("settings:save", async (_event, next: ConnectionSettings) =>
    requireServices().saveConnectionSettings(next)
  );
  ipcMain.handle("settings:test", async (_event, host: string) =>
    requireServices().testConnectionServer(host)
  );
  ipcMain.handle("settings:ice", async () => requireServices().iceServers());

  ipcMain.handle("pairing:create", async () => requireServices().createPairingCode());
  ipcMain.handle("pairing:read", async (_event, code: string) => requireServices().readPairingCode(code));
  ipcMain.handle("pairing:sas", async (_event, publicKeyBase64: string) =>
    requireServices().sasFor(publicKeyBase64)
  );
  ipcMain.on("pairing:answer", (_event, confirmed: boolean) => {
    requireServices().answerVerification(confirmed === true);
  });
  ipcMain.handle("device:disconnect", async (_event, deviceId: string) => {
    await requireServices().disconnectDevice(deviceId);
    return requireServices().snapshot();
  });
  ipcMain.handle("device:reconnect", async (_event, deviceId: string) => {
    await requireServices().reconnectDevice(deviceId);
    return requireServices().snapshot();
  });
  ipcMain.handle("device:forget", async (_event, deviceId: string) => {
    await requireServices().forgetDevice(deviceId);
    return requireServices().snapshot();
  });

  ipcMain.handle("rendezvous:for", async (_event, deviceId: string) => {
    const services = requireServices();
    const where = services.rendezvousFor(deviceId);
    if (where === undefined) {
      return { error: "This device was paired before reconnect was supported. Pair it again." };
    }
    const peer = (await services.snapshot()).pairedDevices.find((d) => d.deviceId === deviceId);
    return { ...where, peerName: peer?.name ?? "the paired device" };
  });

  ipcMain.handle("rendezvous:standing", async () => {
    const standing = requireServices().standingRendezvous();
    return standing === undefined
      ? undefined
      : {
          roomId: standing.roomId,
          inviteToken: standing.inviteToken,
          signalUrl: standing.signalUrl,
          peerName: standing.name
        };
  });

  ipcMain.handle("session:run", async (_event, input: { peerId: string; pairingMode: boolean }) =>
    requireServices().runSession(input.peerId, input.pairingMode)
  );

  ipcMain.on("peer:inbound", (_event, frame: PeerFrame) => {
    requireServices().peers.deliverInbound(frame);
  });
  ipcMain.on("peer:buffered", (_event, peerId: string, bytes: number) => {
    requireServices().peers.reportBuffered(peerId, bytes);
  });
  ipcMain.on("peer:open", (_event, peerId: string) => {
    requireServices().peerOpened(peerId);
  });
  ipcMain.on("peer:closed", (_event, peerId: string) => {
    // The channel is genuinely gone — only the renderer's teardown sends this,
    // never the end of a session — so presence ends here as well as the link.
    requireServices().peerGone(peerId);
    requireServices().peers.closeLink(peerId);
  });

  ipcMain.handle(
    "merge:preview",
    async (_event, input: { baseRevisionId: string; incomingRevisionIds: string[]; password: string }) =>
      requireServices().previewMerge(input)
  );
  ipcMain.handle(
    "merge:run",
    async (_event, input: { baseRevisionId: string; incomingRevisionIds: string[]; password: string }) =>
      requireServices().merge(input)
  );
  ipcMain.handle(
    "merge:combineAndUse",
    async (_event, input: { otherVersionId: string; password: string }) =>
      requireServices().combineAndUse(input)
  );
  ipcMain.handle(
    "conflict:resolve",
    async (
      _event,
      input: { conflictId: string; decision: "keep-current" | "switch-incoming" | "save-both" }
    ) => {
      await requireServices().resolveConflict(input.conflictId, input.decision);
      return requireServices().snapshot();
    }
  );
}

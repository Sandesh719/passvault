/**
 * The IPC contract between the renderer and the main process.
 *
 * The split follows capability, not convenience. The main process owns the
 * filesystem, the database, and the private key; the renderer owns the window
 * and the WebRTC stack, because Chromium's implementation lives there. Neither
 * side can reach the other's resources directly — everything crosses this
 * surface, and the preload script exposes only what is listed here.
 *
 * The shapes crossing it belong to the service that produces them, not to the
 * transport: a phone reads the very same snapshot straight out of memory. Only
 * the calling surface below is specific to there being two processes.
 */
import type { VaultApi } from "@passvault/services";
import type { ChannelName, PeerFrame, PeerTransportHost } from "@passvault/transport";

export type * from "@passvault/services";
export type { ChannelName, PeerFrame };

/**
 * What the renderer may call, and nothing else.
 *
 * `VaultApi` is the application surface, shared with Android. The transport
 * half below exists only because the desktop splits the engine and the WebRTC
 * stack across two processes; a phone has them in one and needs none of it.
 */
export interface DesktopApi extends VaultApi, PeerTransportHost {
  peerInbound(frame: PeerFrame): void;
  peerBuffered(peerId: string, bytes: number): void;
  /** Both channels to this peer are open. Presence starts here, not at the session. */
  peerOpen(peerId: string): void;
  peerClosed(peerId: string): void;
  onPeerOutbound(listener: (frame: PeerFrame) => void): () => void;
}

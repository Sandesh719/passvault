export type ChannelName = "control" | "bulk";

/**
 * One message to or from a peer, in a form that survives being handed across a
 * boundary.
 *
 * Here rather than in the desktop app's IPC contract because the boundary is
 * not always IPC. On the desktop the engine and the data channels live in
 * different processes and these cross between them; on Android they live in
 * one JavaScript context and the same frames are passed by function call. The
 * code either side of the boundary is identical, which is the point.
 */
export interface PeerFrame {
  readonly peerId: string;
  readonly channel: ChannelName;
  /** Control frames are JSON text; bulk frames are raw bytes. */
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

/**
 * What the WebRTC side needs from whoever owns the sync engine.
 *
 * Narrow on purpose. The desktop renderer satisfies this by forwarding over
 * IPC to the main process; a phone satisfies it by handing frames straight to
 * the link hub in the same context. Neither arrangement is visible from the
 * bridge, so one implementation serves both.
 */
export interface PeerTransportHost {
  peerInbound(frame: PeerFrame): void;
  /** How much the real network queue is holding, so the session throttles on it. */
  peerBuffered(peerId: string, bytes: number): void;
  /** Both channels to this peer are open. */
  peerOpen(peerId: string): void;
  peerClosed(peerId: string): void;
  onPeerOutbound(listener: (frame: PeerFrame) => void): () => void;
}

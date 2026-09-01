import type { DesktopApi, PeerFrame } from "../shared/api.js";

const CONTROL = "passvault/control";
const BULK = "passvault/bulk";
const LOW_WATER_BYTES = 256 * 1024;

export interface BridgeEvents {
  readonly onStatus: (status: string) => void;
  readonly onPeer: (peerId: string) => void;
  readonly onClosed: (peerId: string) => void;
}

/**
 * Owns the WebRTC connection and pipes it to the main process.
 *
 * WebRTC lives here because Chromium's implementation does, and the main
 * process should not be running a browser engine to get it. The main process
 * still drives the protocol — this side moves bytes and reports how backed up
 * the outbound queue is, so the session throttles on the real network rather
 * than on IPC.
 */
export class PeerBridge {
  private socket: WebSocket | undefined;
  private readonly connections = new Map<string, RTCPeerConnection>();
  private readonly control = new Map<string, RTCDataChannel>();
  private readonly bulk = new Map<string, RTCDataChannel>();
  private readonly ready = new Set<string>();
  private detachOutbound: (() => void) | undefined;
  private localPeerId = crypto.randomUUID();
  /** Distinguishes a hangup we caused from one we suffered. */
  private closingDeliberately = false;

  /**
   * STUN alone, until settings say otherwise.
   *
   * Replaceable rather than fixed at construction: a relay can be configured
   * while the app is running, and rebuilding the bridge to apply it would tear
   * down the socket it is currently sitting on.
   */
  private iceServers: readonly RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

  public constructor(
    private readonly api: DesktopApi,
    private readonly events: BridgeEvents,
    iceServers?: readonly RTCIceServer[]
  ) {
    if (iceServers !== undefined) {
      this.iceServers = iceServers;
    }
  }

  /** Applies to connections opened from now on, not to one already running. */
  public useIceServers(servers: readonly RTCIceServer[]): void {
    if (servers.length > 0) {
      this.iceServers = servers;
    }
  }

  public connect(input: { signalUrl: string; roomId: string; inviteToken: string }): void {
    this.disconnect();
    this.closingDeliberately = false;
    this.detachOutbound = this.api.onPeerOutbound((frame) => this.forwardOutbound(frame));

    this.events.onStatus(`Connecting to ${input.signalUrl}…`);
    const socket = new WebSocket(input.signalUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.events.onStatus("Connected to the signaling server.");
      socket.send(
        JSON.stringify({
          type: "join",
          roomId: input.roomId,
          inviteToken: input.inviteToken,
          peerId: this.localPeerId
        })
      );
    });

    socket.addEventListener("message", (event) => {
      void this.handleSignal(JSON.parse(String(event.data)) as SignalMessage);
    });

    socket.addEventListener("error", () =>
      this.events.onStatus(
        `Could not reach the signaling server at ${input.signalUrl}. Is it running? (pnpm signaling)`
      )
    );

    socket.addEventListener("close", (event) => {
      if (this.closingDeliberately) {
        return;
      }
      const detail = (event as CloseEvent).reason;
      // A close with no reason and no prior handshake almost always means the
      // server was never reachable, which is a different problem than a peer
      // dropping mid-session — say which.
      this.events.onStatus(
        detail.length > 0
          ? `Signaling connection closed: ${detail}`
          : "Signaling connection closed before the other device appeared."
      );
    });
  }

  public disconnect(): void {
    this.closingDeliberately = true;
    this.detachOutbound?.();
    this.detachOutbound = undefined;
    for (const peerId of [...this.connections.keys()]) {
      this.teardown(peerId);
    }
    this.socket?.close();
    this.socket = undefined;
  }

  private async handleSignal(message: SignalMessage): Promise<void> {
    if (message.type === "joined") {
      this.events.onStatus(
        message.existingPeerIds.length === 0
          ? "Waiting for the other device to join."
          : "Found the other device. Connecting."
      );
      for (const peerId of message.existingPeerIds) {
        // Exactly one side must create the channels; the peer already in the
        // room takes that role.
        await this.openConnection(peerId, true);
      }
      return;
    }
    if (message.type === "peer-joined") {
      await this.openConnection(message.peerId, false);
      return;
    }
    if (message.type === "peer-left") {
      this.teardown(message.peerId);
      return;
    }
    if (message.type === "signal") {
      await this.applySignal(message.fromPeerId, message.payload);
      return;
    }
    if (message.type === "error") {
      // Previously dropped on the floor, so a rejected join looked like silence.
      this.events.onStatus(`Signaling server refused: ${message.message}`);
    }
  }

  private async openConnection(peerId: string, initiator: boolean): Promise<void> {
    if (this.connections.has(peerId)) {
      return;
    }
    const connection = new RTCPeerConnection({ iceServers: [...this.iceServers] });
    this.connections.set(peerId, connection);

    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate !== null) {
        this.sendSignal(peerId, { type: "ice", candidate: event.candidate.toJSON() });
      }
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed") {
        this.events.onStatus(
          "Direct connection failed. A TURN relay would be needed on this network."
        );
      }
    });
    connection.addEventListener("datachannel", (event) => this.attach(peerId, event.channel));

    if (initiator) {
      this.attach(peerId, connection.createDataChannel(CONTROL, { ordered: true }));
      this.attach(peerId, connection.createDataChannel(BULK, { ordered: true }));
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      this.sendSignal(peerId, { type: "offer", description: offer });
    }
  }

  private attach(peerId: string, channel: RTCDataChannel): void {
    const isBulk = channel.label === BULK;
    if (isBulk) {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
      channel.addEventListener("bufferedamountlow", () =>
        this.api.peerBuffered(peerId, channel.bufferedAmount)
      );
    }
    (isBulk ? this.bulk : this.control).set(peerId, channel);

    channel.addEventListener("message", (event) => {
      const data: unknown = (event as MessageEvent).data;
      if (isBulk && data instanceof ArrayBuffer) {
        this.api.peerInbound({ peerId, channel: "bulk", bytes: new Uint8Array(data) });
        return;
      }
      if (!isBulk && typeof data === "string") {
        this.api.peerInbound({ peerId, channel: "control", text: data });
      }
    });

    channel.addEventListener("open", () => this.maybeReady(peerId));
    channel.addEventListener("close", () => this.teardown(peerId));
  }

  private maybeReady(peerId: string): void {
    const control = this.control.get(peerId);
    const bulk = this.bulk.get(peerId);
    if (control?.readyState !== "open" || bulk?.readyState !== "open" || this.ready.has(peerId)) {
      return;
    }
    this.ready.add(peerId);
    this.events.onPeer(peerId);
  }

  private forwardOutbound(frame: PeerFrame): void {
    const channel = frame.channel === "bulk" ? this.bulk.get(frame.peerId) : this.control.get(frame.peerId);
    if (channel === undefined || channel.readyState !== "open") {
      return;
    }
    if (frame.text !== undefined) {
      channel.send(frame.text);
      return;
    }
    if (frame.bytes !== undefined) {
      const bytes = new Uint8Array(frame.bytes);
      channel.send(bytes.buffer as ArrayBuffer);
      // Report the real queue depth so the session's backpressure reflects the
      // network, not how quickly IPC delivered the chunk.
      this.api.peerBuffered(frame.peerId, channel.bufferedAmount);
    }
  }

  private async applySignal(peerId: string, payload: unknown): Promise<void> {
    const connection = this.connections.get(peerId);
    if (connection === undefined) {
      return;
    }
    const signal = payload as {
      type?: string;
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };

    if (signal.type === "offer" && signal.description !== undefined) {
      await connection.setRemoteDescription(signal.description);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      this.sendSignal(peerId, { type: "answer", description: answer });
      return;
    }
    if (signal.type === "answer" && signal.description !== undefined) {
      await connection.setRemoteDescription(signal.description);
      return;
    }
    if (signal.type === "ice" && signal.candidate !== undefined) {
      await connection.addIceCandidate(signal.candidate);
    }
  }

  private sendSignal(targetPeerId: string, payload: unknown): void {
    this.socket?.send(JSON.stringify({ type: "signal", targetPeerId, payload }));
  }

  private teardown(peerId: string): void {
    this.ready.delete(peerId);
    this.control.get(peerId)?.close();
    this.bulk.get(peerId)?.close();
    this.control.delete(peerId);
    this.bulk.delete(peerId);
    this.connections.get(peerId)?.close();
    this.connections.delete(peerId);
    this.api.peerClosed(peerId);
    this.events.onClosed(peerId);
  }
}

type SignalMessage =
  | { type: "joined"; roomId: string; peerId: string; existingPeerIds: string[] }
  | { type: "peer-joined"; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "signal"; fromPeerId: string; payload: unknown }
  | { type: "error"; message: string };

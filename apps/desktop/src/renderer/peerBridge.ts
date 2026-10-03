import type { DesktopApi, PeerFrame } from "../shared/api.js";

const CONTROL = "passvault/control";
const BULK = "passvault/bulk";
const LOW_WATER_BYTES = 256 * 1024;

export interface BridgeEvents {
  /**
   * A few words for the header chip.
   *
   * The chip is a fixed width and ellipsises, so a sentence put here is a
   * sentence nobody reads the end of. Anything the person may have to act on
   * belongs in `onNotice`.
   */
  readonly onStatus: (status: string) => void;
  /** Something gone wrong that has a next step. Shown in full, and dismissable. */
  readonly onNotice: (message: string) => void;
  readonly onPeer: (peerId: string) => void;
  readonly onClosed: (peerId: string) => void;
}

/** The part of a signaling URL worth showing someone: `wss://host/signal` → `host`. */
function serverName(signalUrl: string): string {
  try {
    return new URL(signalUrl).host;
  } catch {
    return signalUrl;
  }
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
export interface Rendezvous {
  readonly signalUrl: string;
  readonly roomId: string;
  readonly inviteToken: string;
}

/** First wait after a drop. Doubles each failure, so the server is not hammered. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

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
   * The room this device wants to be sitting in.
   *
   * Kept rather than used once: a socket that drops has to be replaced, and
   * without this there was nothing to rebuild it from. A laptop waking, a
   * server restarting, or a phone moving from wi-fi to mobile data each ended
   * the socket, and the device then sat out of the room until the app was
   * restarted — looking, from the other end, exactly like a device that had
   * been turned off.
   */
  private room: Rendezvous | undefined;
  private retryDelayMs = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** An outage is worth one notice, not one per attempt. */
  private outageReported = false;
  private wakeHooked = false;

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

  public connect(input: Rendezvous): void {
    this.disconnect();
    this.room = input;
    this.retryDelayMs = 0;
    this.outageReported = false;
    this.closingDeliberately = false;
    this.detachOutbound = this.api.onPeerOutbound((frame) => this.forwardOutbound(frame));
    this.hookWakeEvents();
    this.openSocket();
  }

  private openSocket(): void {
    const room = this.room;
    if (room === undefined) {
      return;
    }
    const server = serverName(room.signalUrl);
    this.events.onStatus(this.retryDelayMs === 0 ? "Connecting…" : "Reconnecting…");

    let socket: WebSocket;
    try {
      socket = new WebSocket(room.signalUrl);
    } catch {
      // A malformed address throws here rather than failing asynchronously.
      this.scheduleRetry(server);
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      // Only a connection that actually opened clears the backoff; resetting on
      // the attempt would turn a flapping server into a tight loop.
      this.retryDelayMs = 0;
      this.outageReported = false;
      this.events.onStatus("Finding your other device…");
      socket.send(
        JSON.stringify({
          type: "join",
          roomId: room.roomId,
          inviteToken: room.inviteToken,
          peerId: this.localPeerId
        })
      );
    });

    socket.addEventListener("message", (event) => {
      void this.handleSignal(JSON.parse(String(event.data)) as SignalMessage);
    });

    // `error` is always followed by `close`, so retrying is driven from one
    // place; handling both reported every outage twice.
    socket.addEventListener("close", (event) => {
      if (this.closingDeliberately || this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.scheduleRetry(server, (event as CloseEvent).reason);
    });
  }

  /**
   * Try again later, backing off.
   *
   * Deliberately quiet while a peer is still connected: the signaling server
   * introduces two devices and is not needed again afterwards, so a socket
   * dropping mid-session changes nothing the person can see, and saying
   * "disconnected" over a sync that is working would be a lie.
   */
  private scheduleRetry(server: string, detail = ""): void {
    if (this.room === undefined || this.retryTimer !== undefined) {
      return;
    }
    const stillSyncing = this.ready.size > 0;

    this.retryDelayMs =
      this.retryDelayMs === 0 ? FIRST_RETRY_MS : Math.min(this.retryDelayMs * 2, MAX_RETRY_MS);
    // Jitter, so two devices dropped by the same outage do not march back in
    // lockstep and collide on every attempt.
    const wait = this.retryDelayMs * (0.5 + Math.random() * 0.5);

    if (!stillSyncing) {
      this.events.onStatus("Reconnecting…");
      if (!this.outageReported) {
        this.outageReported = true;
        this.events.onNotice(
          detail.length > 0
            ? `${server} closed the connection: ${detail}. Trying again automatically.`
            : `Lost the connection to ${server}. Trying again automatically — check that this device is online, and that the address under Devices → Connection server is right.`
        );
      }
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.openSocket();
    }, wait);
  }

  /**
   * Come back immediately when the device plainly just woke up.
   *
   * Waiting out a thirty-second backoff that began while the laptop was asleep
   * or the phone was in someone's pocket is the difference between sync that
   * feels instant and sync that feels broken.
   */
  private readonly wake = (): void => {
    if (this.room === undefined || this.socket !== undefined) {
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryDelayMs = 0;
    this.openSocket();
  };

  private hookWakeEvents(): void {
    if (this.wakeHooked || typeof window === "undefined") {
      return;
    }
    this.wakeHooked = true;
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
  }

  public disconnect(): void {
    this.closingDeliberately = true;
    this.room = undefined;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.wakeHooked && typeof window !== "undefined") {
      this.wakeHooked = false;
      window.removeEventListener("online", this.wake);
      document.removeEventListener("visibilitychange", this.wake);
    }
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
          ? "Waiting for your other device"
          : "Connecting to your other device…"
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
      // Leaving the signaling room is not the same as the connection dropping.
      // WebRTC outlives the socket that introduced it — that is the whole point
      // of it being peer to peer — so a peer whose signaling blipped used to
      // have a perfectly good data channel torn down underneath it, making
      // every sync exactly as fragile as the server it was trying not to need.
      // The data channel closing is the only authority on whether it is gone.
      if (!this.ready.has(message.peerId)) {
        this.teardown(message.peerId);
      }
      return;
    }
    if (message.type === "signal") {
      await this.applySignal(message.fromPeerId, message.payload);
      return;
    }
    if (message.type === "error") {
      // Previously dropped on the floor, so a rejected join looked like silence.
      this.events.onStatus("Server refused");
      this.events.onNotice(
        `The connection server would not let this device in: ${message.message}. If you were pairing, the code may have expired — ask for a new one.`
      );
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
      const state = connection.connectionState;
      if (state === "failed") {
        this.events.onStatus("Couldn't connect");
        // Both devices reached the server, so this is the network between them
        // — nothing about the address or the code is wrong, and saying "check
        // the server" here sends people to fix something that is already fine.
        this.events.onNotice(
          "Both devices found each other, but no direct connection could be made — some networks, mobile ones especially, block that. Add a relay under Devices → Connection server to get past it."
        );
      }
      // Clear it out either way, so the next `peer-joined` builds a fresh
      // connection instead of returning early on a dead one.
      if (state === "failed" || state === "closed") {
        this.teardown(peerId);
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
    // Before the session, not after: a device is reachable the moment the
    // channels open, and the handshake that names it may take a moment more.
    this.api.peerOpen(peerId);
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

  /**
   * Forget a peer, once.
   *
   * Re-entrant by nature: closing a channel fires that channel's own close
   * event, which lands back here, and a connection going to "failed" closes
   * its channels, which do the same. Everything is removed from the maps
   * *before* anything is closed, so the nested call finds nothing and returns
   * — otherwise the peer is reported closed two or three times over, and with
   * a synchronous channel implementation it does not terminate at all.
   */
  private teardown(peerId: string): void {
    const control = this.control.get(peerId);
    const bulk = this.bulk.get(peerId);
    const connection = this.connections.get(peerId);
    if (control === undefined && bulk === undefined && connection === undefined) {
      return;
    }

    this.ready.delete(peerId);
    this.control.delete(peerId);
    this.bulk.delete(peerId);
    this.connections.delete(peerId);

    control?.close();
    bulk?.close();
    connection?.close();

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

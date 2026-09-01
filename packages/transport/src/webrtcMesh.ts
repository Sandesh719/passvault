import { assert, type PeerId, type PeerLink } from "@passvault/core";
import { createWebRtcLink } from "./webrtcLink.js";

export interface IceConfig {
  /**
   * STUN gets most peers connected directly. TURN is the fallback for networks
   * that refuse to be traversed — symmetric NAT, and a good share of mobile
   * carriers. A relay only ever sees DTLS ciphertext, so it carries traffic
   * without becoming a place vaults are stored.
   */
  readonly iceServers: readonly RTCIceServer[];
}

export const DEFAULT_ICE: IceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

interface PeerRecord {
  readonly connection: RTCPeerConnection;
  readonly link: Promise<PeerLink>;
}

export interface MeshDeps {
  readonly sendSignal: (targetPeerId: PeerId, payload: unknown) => void;
  readonly onLink: (peerId: PeerId, link: PeerLink) => void;
  readonly ice?: IceConfig;
}

/**
 * Manages peer connections and hands each one up as a PeerLink.
 *
 * Deliberately knows nothing about the sync protocol. Its only job is to turn
 * signaling traffic into a connected pair of data channels; what gets said over
 * them is the session's business.
 */
export class WebRtcMesh {
  private readonly peers = new Map<PeerId, PeerRecord>();

  public constructor(private readonly deps: MeshDeps) {}

  /**
   * `initiator` must be true on exactly one side. That side creates the data
   * channels and the offer; the other waits for them.
   */
  public async addPeer(peerId: PeerId, initiator: boolean): Promise<void> {
    assert(!this.peers.has(peerId), "peer must not be added twice");

    const connection = new RTCPeerConnection({
      iceServers: [...(this.deps.ice ?? DEFAULT_ICE).iceServers]
    });

    connection.addEventListener("icecandidate", (event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate !== null) {
        this.deps.sendSignal(peerId, { type: "ice", candidate });
      }
    });

    const link = createWebRtcLink({ connection, remotePeerId: peerId, initiator });
    this.peers.set(peerId, { connection, link });

    void link.then(
      (established) => this.deps.onLink(peerId, established),
      () => this.close(peerId)
    );

    if (initiator) {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      this.deps.sendSignal(peerId, { type: "offer", description: offer });
    }
  }

  public async handleSignal(peerId: PeerId, payload: unknown): Promise<void> {
    const record = this.peers.get(peerId);
    assert(record !== undefined, "peer must exist before handling signal");

    const signal = payload as {
      readonly type?: string;
      readonly description?: RTCSessionDescriptionInit;
      readonly candidate?: RTCIceCandidateInit;
    };

    if (signal.type === "offer") {
      assert(signal.description !== undefined, "offer must include description");
      await record.connection.setRemoteDescription(signal.description);
      const answer = await record.connection.createAnswer();
      await record.connection.setLocalDescription(answer);
      this.deps.sendSignal(peerId, { type: "answer", description: answer });
      return;
    }
    if (signal.type === "answer") {
      assert(signal.description !== undefined, "answer must include description");
      await record.connection.setRemoteDescription(signal.description);
      return;
    }
    if (signal.type === "ice") {
      assert(signal.candidate !== undefined, "ice signal must include candidate");
      await record.connection.addIceCandidate(signal.candidate);
    }
  }

  public close(peerId: PeerId): void {
    const record = this.peers.get(peerId);
    if (record === undefined) {
      return;
    }
    this.peers.delete(peerId);
    void record.link.then(
      (link) => link.close(),
      () => undefined
    );
    record.connection.close();
  }

  public closeAll(): void {
    for (const peerId of [...this.peers.keys()]) {
      this.close(peerId);
    }
  }
}

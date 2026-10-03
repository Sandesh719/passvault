import { startSignalingServer, type SignalingServer } from "@passvault/signaling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, PeerFrame } from "../shared/api.js";
import { PeerBridge } from "./peerBridge.js";

/**
 * Exercises the renderer's signaling half against the real server.
 *
 * WebRTC itself is stubbed — Node has no RTCPeerConnection — but everything up
 * to and including the offer/answer exchange is real: real WebSockets, the real
 * room registry, the real bridge. That is precisely the stretch where pairing
 * was failing with one window waiting and the other reporting a closed socket.
 */

interface Recorded {
  readonly createdOffers: number;
  readonly remoteDescriptions: string[];
  readonly createdAnswers: number;
}

const peers: Recorded[] = [];

const channels: FakeDataChannel[] = [];

class FakeDataChannel extends EventTarget {
  public readyState = "connecting";
  public bufferedAmount = 0;
  public binaryType = "arraybuffer";
  public bufferedAmountLowThreshold = 0;
  public constructor(public readonly label: string) {
    super();
    channels.push(this);
  }
  public send(): void {}
  /** Let a test take the channel live, which is what makes a peer "ready". */
  public open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
  public close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

/** Records what the bridge asked of it; performs no actual networking. */
class FakeRTCPeerConnection extends EventTarget {
  public connectionState = "new";
  public readonly record: { createdOffers: number; remoteDescriptions: string[]; createdAnswers: number } = {
    createdOffers: 0,
    remoteDescriptions: [],
    createdAnswers: 0
  };

  public constructor() {
    super();
    peers.push(this.record);
  }

  public createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }

  public async createOffer(): Promise<{ type: string; sdp: string }> {
    this.record.createdOffers += 1;
    return { type: "offer", sdp: "fake-offer" };
  }

  public async createAnswer(): Promise<{ type: string; sdp: string }> {
    this.record.createdAnswers += 1;
    return { type: "answer", sdp: "fake-answer" };
  }

  public async setLocalDescription(): Promise<void> {}

  public async setRemoteDescription(description: { sdp?: string }): Promise<void> {
    this.record.remoteDescriptions.push(description.sdp ?? "");
  }

  public async addIceCandidate(): Promise<void> {}

  public close(): void {
    this.connectionState = "closed";
  }
}

function stubApi(): DesktopApi {
  const noop = (): void => {};
  return {
    getSnapshot: vi.fn(),
    onSnapshot: () => noop,
    chooseVault: vi.fn(),
    writeBack: vi.fn(),
    promote: vi.fn(),
    createPairingCode: vi.fn(),
    readPairingCode: vi.fn(),
    shortAuthenticationString: vi.fn(),
    forgetDevice: vi.fn(),
    runSession: vi.fn(),
    peerInbound: (_frame: PeerFrame) => {},
    peerBuffered: () => {},
    peerOpen: () => {},
    peerClosed: () => {},
    onPeerOutbound: () => noop,
    previewMerge: vi.fn(),
    merge: vi.fn(),
    resolveConflict: vi.fn()
  } as unknown as DesktopApi;
}

let server: SignalingServer;
const bridges: PeerBridge[] = [];

beforeEach(async () => {
  peers.length = 0;
  channels.length = 0;
  server = await startSignalingServer(0);
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakeRTCPeerConnection;
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    bridge.disconnect();
  }
  await server.close();
});

async function createRoom(): Promise<{ roomId: string; inviteToken: string; signalUrl: string }> {
  const response = await fetch(`http://127.0.0.1:${server.port}/rooms`, { method: "POST" });
  const room = (await response.json()) as { roomId: string; inviteToken: string };
  return { ...room, signalUrl: `ws://127.0.0.1:${server.port}/signal` };
}

/**
 * `statuses` collects the short header text; `notices` the long, actionable
 * kind. They are separate because the header chip ellipsises, so a status that
 * needs reading to the end is one nobody reads.
 */
function makeBridge(statuses: string[], notices: string[] = []): PeerBridge {
  const bridge = new PeerBridge(stubApi(), {
    onStatus: (status) => statuses.push(status),
    onNotice: (notice) => notices.push(notice),
    onPeer: () => statuses.push("PEER-READY"),
    onClosed: () => statuses.push("PEER-CLOSED")
  });
  bridges.push(bridge);
  return bridge;
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("PeerBridge against a real signaling server", () => {
  it("completes the offer/answer exchange between two windows", async () => {
    const room = await createRoom();
    const hostStatuses: string[] = [];
    const guestStatuses: string[] = [];

    // The window that created the code connects first and waits.
    makeBridge(hostStatuses).connect(room);
    await waitFor(
      () => hostStatuses.includes("Waiting for your other device"),
      "the host to join the room"
    );

    // The window that pasted the code joins second and starts negotiation.
    makeBridge(guestStatuses).connect(room);
    await waitFor(
      () => guestStatuses.includes("Connecting to your other device…"),
      "the guest to see the host"
    );

    // Guest offers, host answers, guest applies it. If the socket had closed —
    // the bug this test exists for — none of these would happen.
    await waitFor(() => peers.some((peer) => peer.createdOffers > 0), "an offer");
    await waitFor(() => peers.some((peer) => peer.createdAnswers > 0), "an answer");
    await waitFor(
      () => peers.some((peer) => peer.remoteDescriptions.includes("fake-answer")),
      "the answer to reach the offerer"
    );

    expect(hostStatuses).not.toContain("Not connected");
    expect(guestStatuses).not.toContain("Not connected");
  }, 30_000);

  it("reports a refused join instead of failing silently", async () => {
    const room = await createRoom();
    const statuses: string[] = [];
    const notices: string[] = [];
    makeBridge(statuses, notices).connect({ ...room, inviteToken: "not-the-right-token" });

    await waitFor(() => notices.length > 0, "the refusal to surface");
    // The chip says only that something was refused; the reason, and what to do
    // about it, go where there is room to read them.
    expect(statuses).toContain("Server refused");
    expect(notices[0]).toMatch(/invite token/u);
    expect(notices[0]).toMatch(/expired/u);
  }, 30_000);

  it("names the address to check when the server cannot be reached", async () => {
    const statuses: string[] = [];
    const notices: string[] = [];
    makeBridge(statuses, notices).connect({
      signalUrl: "ws://127.0.0.1:1/signal",
      roomId: "r",
      inviteToken: "t"
    });

    await waitFor(() => notices.length > 0, "the problem to surface");
    // It used to tell whoever hit this to run `pnpm signaling`, which is an
    // instruction for someone working on the app, not someone using it.
    expect(notices.join(" ")).not.toMatch(/pnpm/u);
    expect(notices.join(" ")).toMatch(/127\.0\.0\.1:1/u);
    expect(notices.join(" ")).toMatch(/Connection server/u);
  }, 30_000);

  it("rejoins the room by itself after the server goes away and comes back", async () => {
    // The failure this exists for: the socket was created once and never
    // replaced, so a server restart — or a laptop sleeping, or a phone changing
    // network — left the device silently outside the room until it was
    // relaunched. The other device saw that as "simply not there".
    const port = server.port;
    const room = await createRoom();
    const statuses: string[] = [];
    makeBridge(statuses).connect(room);
    await waitFor(() => statuses.includes("Waiting for your other device"), "the first join");

    await server.close();
    await waitFor(() => statuses.includes("Reconnecting…"), "the drop to be noticed");

    // Same port, so the device's stored rendezvous still points at it.
    server = await startSignalingServer(port);
    await waitFor(
      () => statuses.lastIndexOf("Waiting for your other device") > statuses.indexOf("Reconnecting…"),
      "the rejoin",
      20_000
    );
  }, 40_000);

  it("keeps a working peer connection when signaling says the peer left", async () => {
    const room = await createRoom();
    const hostStatuses: string[] = [];
    const guestStatuses: string[] = [];

    const host = makeBridge(hostStatuses);
    host.connect(room);
    await waitFor(() => hostStatuses.includes("Waiting for your other device"), "the host to join");

    // The second to arrive creates the channels, so it is the side that can
    // reach "ready" against the stubbed WebRTC.
    makeBridge(guestStatuses).connect(room);
    await waitFor(() => channels.length >= 2, "the guest to create its channels");
    for (const channel of channels) {
      channel.open();
    }
    await waitFor(() => guestStatuses.includes("PEER-READY"), "the guest to become ready");

    // Now the host leaves the room. Its data channel to the guest is still
    // open, and WebRTC needs no server once two devices have been introduced,
    // so tearing the connection down here would make every sync exactly as
    // fragile as the socket it was trying not to depend on.
    host.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(guestStatuses).not.toContain("PEER-CLOSED");
  }, 30_000);

  it("stays quiet when the disconnect was our own doing", async () => {
    const room = await createRoom();
    const statuses: string[] = [];
    const notices: string[] = [];
    const bridge = makeBridge(statuses, notices);
    bridge.connect(room);
    await waitFor(() => statuses.includes("Finding your other device…"), "the connection");

    bridge.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Reporting our own teardown as a failure is how the original bug disguised
    // itself as a server problem.
    expect(statuses).not.toContain("Not connected");
    expect(notices).toEqual([]);
  }, 30_000);
});

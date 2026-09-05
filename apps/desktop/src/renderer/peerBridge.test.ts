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

class FakeDataChannel extends EventTarget {
  public readyState = "connecting";
  public bufferedAmount = 0;
  public binaryType = "arraybuffer";
  public bufferedAmountLowThreshold = 0;
  public constructor(public readonly label: string) {
    super();
  }
  public send(): void {}
  public close(): void {
    this.readyState = "closed";
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

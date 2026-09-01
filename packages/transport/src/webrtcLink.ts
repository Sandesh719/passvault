import { brand, type Channel, type PeerId, type PeerLink } from "@passvault/core";

/** Resume sending once the outbound queue falls to this. */
const LOW_WATER_BYTES = 256 * 1024;

export const CONTROL_CHANNEL = "passvault/control";
export const BULK_CHANNEL = "passvault/bulk";

class RtcChannel<T extends string | Uint8Array> implements Channel<T> {
  public constructor(
    private readonly channel: RTCDataChannel,
    private readonly binary: boolean
  ) {
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    if (binary) {
      channel.binaryType = "arraybuffer";
    }
  }

  public send(data: T): void {
    if (this.channel.readyState !== "open") {
      return;
    }
    if (typeof data === "string") {
      this.channel.send(data);
      return;
    }
    // Copy onto an exact-length buffer: a subarray view would otherwise send
    // the whole underlying allocation.
    const bytes = new Uint8Array(data);
    this.channel.send(bytes.buffer as ArrayBuffer);
  }

  public get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  /**
   * Wait for the browser's send queue to drain.
   *
   * `bufferedamountlow` is the only backpressure signal a data channel offers.
   * Without it, a loop that pushes a multi-megabyte vault as fast as it can
   * will outrun SCTP and the connection is closed under it.
   */
  public drain(): Promise<void> {
    if (this.channel.bufferedAmount <= LOW_WATER_BYTES || this.channel.readyState !== "open") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.channel.removeEventListener("bufferedamountlow", done);
        this.channel.removeEventListener("close", done);
        resolve();
      };
      this.channel.addEventListener("bufferedamountlow", done);
      this.channel.addEventListener("close", done);
    });
  }

  public onMessage(handler: (data: T) => void): void {
    this.channel.addEventListener("message", (event) => {
      const raw: unknown = (event as MessageEvent).data;
      if (this.binary) {
        if (raw instanceof ArrayBuffer) {
          handler(new Uint8Array(raw) as T);
        }
        return;
      }
      if (typeof raw === "string") {
        handler(raw as T);
      }
    });
  }

  public onClose(handler: () => void): void {
    this.channel.addEventListener("close", handler);
  }

  public close(): void {
    if (this.channel.readyState === "open" || this.channel.readyState === "connecting") {
      this.channel.close();
    }
  }
}

function whenOpen(channel: RTCDataChannel): Promise<RTCDataChannel> {
  if (channel.readyState === "open") {
    return Promise.resolve(channel);
  }
  return new Promise((resolve, reject) => {
    channel.addEventListener("open", () => resolve(channel), { once: true });
    channel.addEventListener("error", () => reject(new Error(`data channel ${channel.label} failed`)), {
      once: true
    });
    channel.addEventListener("close", () => reject(new Error(`data channel ${channel.label} closed`)), {
      once: true
    });
  });
}

/**
 * Build a PeerLink over an established RTCPeerConnection.
 *
 * Two channels, not one. Vault bytes can occupy the bulk channel for a long
 * time; acks, cancels, and headers must not queue behind them.
 *
 * Only the impolite peer creates channels — both creating them would produce
 * four, of which two would never be read.
 */
export async function createWebRtcLink(input: {
  readonly connection: RTCPeerConnection;
  readonly remotePeerId: PeerId;
  readonly initiator: boolean;
}): Promise<PeerLink> {
  const { connection, initiator } = input;

  const awaited = new Map<string, (channel: RTCDataChannel) => void>();
  const incoming = new Map<string, RTCDataChannel>();
  connection.addEventListener("datachannel", (event) => {
    const channel = (event as RTCDataChannelEvent).channel;
    const waiter = awaited.get(channel.label);
    if (waiter === undefined) {
      incoming.set(channel.label, channel);
      return;
    }
    awaited.delete(channel.label);
    waiter(channel);
  });

  const expect = (label: string): Promise<RTCDataChannel> => {
    const already = incoming.get(label);
    if (already !== undefined) {
      incoming.delete(label);
      return Promise.resolve(already);
    }
    return new Promise((resolve) => awaited.set(label, resolve));
  };

  const [controlChannel, bulkChannel] = initiator
    ? await Promise.all([
        whenOpen(connection.createDataChannel(CONTROL_CHANNEL, { ordered: true })),
        whenOpen(connection.createDataChannel(BULK_CHANNEL, { ordered: true }))
      ])
    : await Promise.all([
        expect(CONTROL_CHANNEL).then(whenOpen),
        expect(BULK_CHANNEL).then(whenOpen)
      ]);

  const control = new RtcChannel<string>(controlChannel, false);
  const bulk = new RtcChannel<Uint8Array>(bulkChannel, true);

  return {
    remotePeerId: input.remotePeerId,
    control,
    bulk,
    close: () => {
      control.close();
      bulk.close();
    }
  };
}

export function peerIdFrom(value: string): PeerId {
  return brand<string, "PeerId">(value);
}

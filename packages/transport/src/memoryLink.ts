import { brand, type Channel, type PeerLink } from "@passvault/core";

export interface MemoryLinkOptions {
  /** Bytes buffered before `drain()` starts making callers wait. */
  readonly lowWaterBytes?: number;
  /** Deliver on a macrotask instead of a microtask, to interleave more aggressively. */
  readonly deliveryDelayMs?: number;
}

class MemoryChannel<T extends string | Uint8Array> implements Channel<T> {
  private peer: MemoryChannel<T> | undefined;
  private handler: ((data: T) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private buffered = 0;
  private closed = false;
  private drainWaiters: (() => void)[] = [];
  /** Every byte that has ever been queued. Lets tests assert on real traffic volume. */
  public totalBytesSent = 0;
  public peakBufferedAmount = 0;

  public constructor(private readonly options: Required<MemoryLinkOptions>) {}

  public connect(peer: MemoryChannel<T>): void {
    this.peer = peer;
  }

  public send(data: T): void {
    if (this.closed) {
      return;
    }
    const size = byteSize(data);
    this.buffered += size;
    this.totalBytesSent += size;
    this.peakBufferedAmount = Math.max(this.peakBufferedAmount, this.buffered);

    const deliver = (): void => {
      this.buffered -= size;
      this.peer?.receive(data);
      if (this.buffered <= this.options.lowWaterBytes) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const waiter of waiters) {
          waiter();
        }
      }
    };
    if (this.options.deliveryDelayMs > 0) {
      setTimeout(deliver, this.options.deliveryDelayMs);
    } else {
      queueMicrotask(deliver);
    }
  }

  public get bufferedAmount(): number {
    return this.buffered;
  }

  public drain(): Promise<void> {
    if (this.buffered <= this.options.lowWaterBytes) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  public onMessage(handler: (data: T) => void): void {
    this.handler = handler;
  }

  public onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeHandler?.();
    this.peer?.close();
  }

  private receive(data: T): void {
    if (!this.closed) {
      this.handler?.(data);
    }
  }
}

export interface MemoryLinkPair {
  readonly a: PeerLink;
  readonly b: PeerLink;
  /** Channel internals, for assertions about wire volume and backpressure. */
  readonly stats: {
    readonly aBulk: MemoryChannel<Uint8Array>;
    readonly bBulk: MemoryChannel<Uint8Array>;
    readonly aControl: MemoryChannel<string>;
    readonly bControl: MemoryChannel<string>;
  };
}

/**
 * Two peer links wired directly to each other, with no WebRTC and no network.
 *
 * This is what makes the session testable. The full protocol — handshake,
 * history exchange, chunked transfer, acks, backpressure — runs end to end in a
 * single process, so protocol bugs surface in milliseconds instead of behind a
 * signaling server and a NAT traversal.
 *
 * Delivery is asynchronous and control and bulk are independent, which
 * reproduces the one ordering hazard that matters: a chunk can arrive before
 * the header that describes it.
 */
export function createMemoryLinkPair(options: MemoryLinkOptions = {}): MemoryLinkPair {
  const resolved: Required<MemoryLinkOptions> = {
    lowWaterBytes: options.lowWaterBytes ?? 256 * 1024,
    deliveryDelayMs: options.deliveryDelayMs ?? 0
  };

  const aControl = new MemoryChannel<string>(resolved);
  const bControl = new MemoryChannel<string>(resolved);
  const aBulk = new MemoryChannel<Uint8Array>(resolved);
  const bBulk = new MemoryChannel<Uint8Array>(resolved);

  aControl.connect(bControl);
  bControl.connect(aControl);
  aBulk.connect(bBulk);
  bBulk.connect(aBulk);

  const a: PeerLink = {
    remotePeerId: brand<string, "PeerId">("memory-peer-b"),
    control: aControl,
    bulk: aBulk,
    close: () => {
      aControl.close();
      aBulk.close();
    }
  };
  const b: PeerLink = {
    remotePeerId: brand<string, "PeerId">("memory-peer-a"),
    control: bControl,
    bulk: bBulk,
    close: () => {
      bControl.close();
      bBulk.close();
    }
  };

  return { a, b, stats: { aBulk, bBulk, aControl, bControl } };
}

function byteSize(data: string | Uint8Array): number {
  return typeof data === "string" ? data.length : data.byteLength;
}

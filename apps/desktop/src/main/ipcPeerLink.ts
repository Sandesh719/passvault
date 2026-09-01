import { brand, type Channel, type PeerLink } from "@passvault/core";
import type { ChannelName, PeerFrame } from "../shared/api.js";

const LOW_WATER_BYTES = 256 * 1024;

/**
 * A PeerLink whose bytes travel over IPC to the renderer, which owns the real
 * data channels.
 *
 * This exists because the two halves of the app live in different processes for
 * good reasons — the main process must not run untrusted web content, and
 * Chromium's WebRTC stack only exists in the renderer — and the session should
 * not have to know that. The port designed for in-memory tests turns out to
 * bridge a process boundary just as well.
 *
 * Backpressure survives the crossing: the renderer reports its channel's real
 * `bufferedAmount`, so the session is throttled by the actual network queue and
 * not by how fast IPC happens to be.
 */
class IpcChannel<T extends string | Uint8Array> implements Channel<T> {
  private handler: ((data: T) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  private buffered = 0;
  private drainWaiters: (() => void)[] = [];
  private closed = false;

  public constructor(
    private readonly peerId: string,
    private readonly channel: ChannelName,
    private readonly emit: (frame: PeerFrame) => void
  ) {}

  public send(data: T): void {
    if (this.closed) {
      return;
    }
    this.emit(
      typeof data === "string"
        ? { peerId: this.peerId, channel: this.channel, text: data }
        : { peerId: this.peerId, channel: this.channel, bytes: data }
    );
  }

  public get bufferedAmount(): number {
    return this.buffered;
  }

  public drain(): Promise<void> {
    if (this.closed || this.buffered <= LOW_WATER_BYTES) {
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
    this.releaseWaiters();
    this.closeHandler?.();
  }

  public deliver(data: T): void {
    if (!this.closed) {
      this.handler?.(data);
    }
  }

  public reportBuffered(bytes: number): void {
    this.buffered = bytes;
    if (bytes <= LOW_WATER_BYTES) {
      this.releaseWaiters();
    }
  }

  private releaseWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
}

interface LinkRecord {
  readonly link: PeerLink;
  readonly control: IpcChannel<string>;
  readonly bulk: IpcChannel<Uint8Array>;
}

export class IpcPeerLinkHub {
  private readonly links = new Map<string, LinkRecord>();

  public constructor(private readonly emit: (frame: PeerFrame) => void) {}

  public createLink(peerId: string): PeerLink {
    this.closeLink(peerId);

    const control = new IpcChannel<string>(peerId, "control", this.emit);
    const bulk = new IpcChannel<Uint8Array>(peerId, "bulk", this.emit);
    const link: PeerLink = {
      remotePeerId: brand<string, "PeerId">(peerId),
      control,
      bulk,
      close: () => this.closeLink(peerId)
    };

    this.links.set(peerId, { link, control, bulk });
    return link;
  }

  public deliverInbound(frame: PeerFrame): void {
    const record = this.links.get(frame.peerId);
    if (record === undefined) {
      return;
    }
    if (frame.channel === "control" && frame.text !== undefined) {
      record.control.deliver(frame.text);
      return;
    }
    if (frame.channel === "bulk" && frame.bytes !== undefined) {
      // Structured clone hands us a copy already; normalise the view type.
      record.bulk.deliver(new Uint8Array(frame.bytes));
    }
  }

  public reportBuffered(peerId: string, bytes: number): void {
    // Only the bulk channel can realistically back up.
    this.links.get(peerId)?.bulk.reportBuffered(bytes);
  }

  public closeLink(peerId: string): void {
    const record = this.links.get(peerId);
    if (record === undefined) {
      return;
    }
    this.links.delete(peerId);
    record.control.close();
    record.bulk.close();
  }

  public closeAll(): void {
    for (const peerId of [...this.links.keys()]) {
      this.closeLink(peerId);
    }
  }
}

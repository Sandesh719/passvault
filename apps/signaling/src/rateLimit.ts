import type { IncomingMessage } from "node:http";

/**
 * A token bucket per client, in memory.
 *
 * Deliberately not a distributed limiter. This server holds no state worth
 * sharing between instances, so a per-instance bucket is the honest shape: it
 * bounds what one process will do, which is what actually protects it.
 *
 * The point is not to stop a determined attacker — nothing here does — but to
 * keep a loop of requests from filling memory faster than the sweeper empties
 * it.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  public constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now
  ) {}

  public take(key: string): boolean {
    const at = this.now();
    // Bounded so the limiter cannot itself become the leak it exists to stop.
    if (this.buckets.size > 100_000) {
      this.buckets.clear();
    }

    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: at };
    const refilled = Math.min(
      this.capacity,
      bucket.tokens + ((at - bucket.updatedAt) / 1000) * this.refillPerSecond
    );

    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, updatedAt: at });
      return false;
    }
    this.buckets.set(key, { tokens: refilled - 1, updatedAt: at });
    return true;
  }
}

/**
 * Who to charge a request to.
 *
 * `X-Forwarded-For` is trusted only when the operator says the server sits
 * behind a proxy — otherwise any client could name its own bucket by sending
 * the header, and the limiter would do nothing.
 *
 * Even then, the **last** entry is the one to use, never the first. A proxy
 * appends the address it saw to whatever the client sent, so the header arrives
 * as `whatever-the-client-claimed, the-real-address`. Reading from the front
 * takes the attacker's value; reading from the back takes the one the proxy
 * vouched for. This was wrong in the first version and a spoofed header bought
 * an unlimited supply of fresh rate-limit buckets.
 */
export function clientKey(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = request.headers["x-forwarded-for"];
    const raw = Array.isArray(header) ? header[header.length - 1] : header;
    const hops = (raw ?? "")
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const nearest = hops[hops.length - 1];
    if (nearest !== undefined) {
      return nearest;
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}

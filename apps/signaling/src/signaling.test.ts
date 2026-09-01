import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brand, type PeerId } from "@passvault/core";
import { startSignalingServer, type SignalingServer } from "./index.js";
import { clientKey } from "./rateLimit.js";
import { RoomRegistry } from "./rooms.js";

/**
 * Drives the real server over real sockets.
 *
 * The desktop app reported a peer connecting fine while the other saw the
 * connection close, and there was no way to tell whether the fault was in the
 * server or in the window. This isolates the server half.
 */

let server: SignalingServer;
let baseUrl: string;
let socketUrl: string;
const open: WebSocket[] = [];

beforeEach(async () => {
  server = await startSignalingServer(0);
  baseUrl = `http://127.0.0.1:${server.port}`;
  socketUrl = `ws://127.0.0.1:${server.port}/signal`;
});

afterEach(async () => {
  for (const socket of open.splice(0)) {
    socket.close();
  }
  await server.close();
});

async function createRoom(): Promise<{ roomId: string; inviteToken: string }> {
  const response = await fetch(`${baseUrl}/rooms`, { method: "POST" });
  expect(response.status).toBe(201);
  return (await response.json()) as { roomId: string; inviteToken: string };
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    open.push(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Collect every message a socket receives, plus whether it closed. */
function record(socket: WebSocket): {
  messages: Record<string, unknown>[];
  closed: () => boolean;
  next: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
} {
  const messages: Record<string, unknown>[] = [];
  let didClose = false;
  socket.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  socket.on("close", () => {
    didClose = true;
  });

  return {
    messages,
    closed: () => didClose,
    next: (type, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        const found = messages.find((message) => message["type"] === type);
        if (found !== undefined) {
          resolve(found);
          return;
        }
        const started = Date.now();
        const tick = (): void => {
          const hit = messages.find((message) => message["type"] === type);
          if (hit !== undefined) {
            resolve(hit);
            return;
          }
          if (didClose) {
            reject(new Error(`socket closed while waiting for ${type}`));
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`timed out waiting for ${type}`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      })
  };
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("signaling server", () => {
  it("reports health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("creates a room with an invite token", async () => {
    const room = await createRoom();
    expect(room.roomId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(room.inviteToken.length).toBeGreaterThan(20);
  });

  it("lets two peers join the same room and see each other", async () => {
    const room = await createRoom();

    const first = await connect();
    const firstLog = record(first);
    first.send(JSON.stringify({ type: "join", ...room, peerId: "peer-one" }));
    const joinedFirst = await firstLog.next("joined");
    expect(joinedFirst["existingPeerIds"]).toEqual([]);

    const second = await connect();
    const secondLog = record(second);
    second.send(JSON.stringify({ type: "join", ...room, peerId: "peer-two" }));

    const joinedSecond = await secondLog.next("joined");
    // The second peer must be told who is already there, or it never starts
    // the offer and both sides sit waiting.
    expect(joinedSecond["existingPeerIds"]).toEqual(["peer-one"]);

    const notified = await firstLog.next("peer-joined");
    expect(notified["peerId"]).toBe("peer-two");

    expect(firstLog.closed()).toBe(false);
    expect(secondLog.closed()).toBe(false);
  });

  it("relays a signal between the two peers", async () => {
    const room = await createRoom();

    const first = await connect();
    const firstLog = record(first);
    first.send(JSON.stringify({ type: "join", ...room, peerId: "peer-one" }));
    await firstLog.next("joined");

    const second = await connect();
    const secondLog = record(second);
    second.send(JSON.stringify({ type: "join", ...room, peerId: "peer-two" }));
    await secondLog.next("joined");

    second.send(
      JSON.stringify({ type: "signal", targetPeerId: "peer-one", payload: { type: "offer" } })
    );
    const relayed = await firstLog.next("signal");
    expect(relayed["fromPeerId"]).toBe("peer-two");
    expect(relayed["payload"]).toEqual({ type: "offer" });
  });

  it("keeps the socket open after rejecting a bad invite token", async () => {
    const room = await createRoom();

    const socket = await connect();
    const log = record(socket);
    socket.send(JSON.stringify({ type: "join", roomId: room.roomId, inviteToken: "wrong", peerId: "p" }));

    const error = await log.next("error");
    expect(String(error["message"])).toMatch(/invite token/u);
    await settle();
    // An error is a reply, not a hangup: closing would leave the client staring
    // at "connection closed" with no idea why.
    expect(log.closed()).toBe(false);
  });

  it("tells the remaining peer when the other leaves", async () => {
    const room = await createRoom();

    const first = await connect();
    const firstLog = record(first);
    first.send(JSON.stringify({ type: "join", ...room, peerId: "peer-one" }));
    await firstLog.next("joined");

    const second = await connect();
    const secondLog = record(second);
    second.send(JSON.stringify({ type: "join", ...room, peerId: "peer-two" }));
    await secondLog.next("joined");
    await firstLog.next("peer-joined");

    second.close();
    const left = await firstLog.next("peer-left");
    expect(left["peerId"]).toBe("peer-two");
  });

  it("survives a malformed message without dropping the connection", async () => {
    const socket = await connect();
    const log = record(socket);
    socket.send("not json at all");

    await log.next("error");
    await settle();
    expect(log.closed()).toBe(false);
  });

  it("refuses to signal before joining", async () => {
    const socket = await connect();
    const log = record(socket);
    socket.send(JSON.stringify({ type: "signal", targetPeerId: "nobody", payload: {} }));

    const error = await log.next("error");
    expect(String(error["message"])).toMatch(/join a room/u);
  });
});

/**
 * Short pairing codes.
 *
 * Retyping a `passvault://` link between two machines is not something
 * anyone will do twice, and once one of the devices is a phone it is not
 * something they can do at all.
 */
describe("short pairing codes", () => {
  async function issue(offer: string): Promise<{ code: string; expiresAt: string }> {
    const response = await fetch(`${baseUrl}/pairing-codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer })
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { code: string; expiresAt: string };
  }

  it("hands back the same offer the code was issued for", async () => {
    const offer = "passvault://pair?v=1&k=abc";
    const { code } = await issue(offer);

    const response = await fetch(`${baseUrl}/pairing-codes/${code}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { offer: string }).toEqual({ offer });
  });

  it("issues something a person can actually retype", async () => {
    const { code } = await issue("passvault://pair?v=1");
    // Eight characters and a dash. Anything longer and people copy-paste or
    // give up, which is the problem this exists to solve.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
  });

  it("forgives the way people type", async () => {
    const offer = "passvault://pair?v=1&k=xyz";
    const { code } = await issue(offer);

    // Lower case, no dash, padded with spaces: all still the same code.
    const typed = ` ${code.replace("-", "").toLowerCase()} `;
    const response = await fetch(`${baseUrl}/pairing-codes/${encodeURIComponent(typed)}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as { offer: string }).toEqual({ offer });
  });

  it("burns a code once it is used", async () => {
    const { code } = await issue("passvault://pair?v=1");
    expect((await fetch(`${baseUrl}/pairing-codes/${code}`)).status).toBe(200);

    // A code that stays valid is a code that can be replayed by whoever saw
    // the screen it was displayed on.
    expect((await fetch(`${baseUrl}/pairing-codes/${code}`)).status).toBe(404);
  });

  it("says nothing useful about a code that does not exist", async () => {
    const response = await fetch(`${baseUrl}/pairing-codes/AAAA-AAAA`);
    expect(response.status).toBe(404);
    // Wrong, expired and already-used must be indistinguishable, or the
    // difference becomes an oracle for someone guessing.
    expect(String((await response.json() as { error: string }).error)).toMatch(/not valid/u);
  });

  it("rejects a request with no offer in it", async () => {
    const response = await fetch(`${baseUrl}/pairing-codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nothing: true })
    });
    expect(response.status).toBe(400);
  });
});

/**
 * Two servers, which is the situation the qualified code exists for.
 *
 * Each server knows only its own codes. Nothing coordinates them, which is why
 * a code has to say where it came from rather than being looked up hopefully.
 */
describe("codes across two servers", () => {
  it("is meaningless on a server that did not issue it", async () => {
    const other = await startSignalingServer(0);
    try {
      const issued = await fetch(`${baseUrl}/pairing-codes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer: "passvault://pair?v=1&k=abc" })
      });
      const { code } = (await issued.json()) as { code: string };

      const wrongServer = await fetch(`http://127.0.0.1:${other.port}/pairing-codes/${code}`);
      expect(wrongServer.status).toBe(404);

      // The same code, asked of the server that issued it, works — so the
      // failure above is about *where* it was asked, not about the code.
      const rightServer = await fetch(`${baseUrl}/pairing-codes/${code}`);
      expect(rightServer.status).toBe(200);
    } finally {
      await other.close();
    }
  });
});

/**
 * Holding up under a public address.
 *
 * On loopback none of this matters. On the internet the server is reachable by
 * anyone, and the failure mode of an unbounded map is an out-of-memory kill
 * rather than an error anyone gets to see.
 */
describe("standing up to abuse", () => {
  it("collects rooms nobody ever joined", () => {
    let now = 0;
    const registry = new RoomRegistry(() => now);
    registry.createRoom();
    registry.createRoom();
    expect(registry.size()).toBe(2);

    // Twenty minutes later, with nobody having joined either of them.
    now += 21 * 60 * 1000;
    expect(registry.sweep()).toBe(2);
    expect(registry.size()).toBe(0);
  });

  it("never collects a room a device is waiting in", () => {
    let now = 0;
    const registry = new RoomRegistry(() => now);
    const { roomId, inviteToken } = registry.createRoom();
    registry.join({
      roomId,
      inviteToken,
      peer: { peerId: brand<string, "PeerId">("peer-1"), send: () => {} }
    });

    // A device sitting in its rendezvous, waiting for the other one to come
    // online, may wait for hours. Sweeping it would break reconnect entirely.
    now += 24 * 60 * 60 * 1000;
    expect(registry.sweep()).toBe(0);
    expect(registry.size()).toBe(1);
  });

  it("refuses to create rooms without limit from one client", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      statuses.push((await fetch(`${baseUrl}/rooms`, { method: "POST" })).status);
    }
    // The bucket allows a burst and then says no, rather than accepting every
    // request until the process dies.
    expect(statuses.filter((status) => status === 201).length).toBeLessThan(40);
    expect(statuses).toContain(429);
  });

  it("rate limits code guessing", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 120; attempt += 1) {
      statuses.push((await fetch(`${baseUrl}/pairing-codes/AAAA-AAA${attempt % 10}`)).status);
    }
    // Eight characters is enough entropy only if guesses cost something.
    expect(statuses).toContain(429);
  });

  it("reports how many rooms it is holding", async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as {
      ok: boolean;
      rooms: number;
    };
    expect(body.ok).toBe(true);
    // A count and nothing else: never a room id, never a peer id.
    expect(typeof body.rooms).toBe("number");
  });
});

/**
 * Deciding who a request belongs to.
 *
 * The rate limiter is only as good as this: get it wrong and a header anyone
 * can send buys an unlimited supply of fresh buckets.
 */
describe("identifying the client behind a proxy", () => {
  const asRequest = (headers: Record<string, string | string[]>, socketAddress = "10.0.0.1") =>
    ({ headers, socket: { remoteAddress: socketAddress } }) as unknown as Parameters<
      typeof clientKey
    >[0];

  it("ignores the header when there is no proxy in front", () => {
    // Without this, every client picks its own bucket and the limiter is
    // decoration.
    expect(clientKey(asRequest({ "x-forwarded-for": "1.2.3.4" }), false)).toBe("10.0.0.1");
  });

  it("takes the address the proxy vouched for, not the one the client claimed", () => {
    // A proxy appends what it saw to whatever arrived, so the client's value is
    // first and the trustworthy one is last. Reading from the front is how a
    // spoofed header defeated the limiter.
    expect(clientKey(asRequest({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), true)).toBe(
      "203.0.113.9"
    );
  });

  it("survives a client sending several hops of its own", () => {
    expect(
      clientKey(asRequest({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.9" }), true)
    ).toBe("203.0.113.9");
  });

  it("falls back to the socket when the header is absent or empty", () => {
    expect(clientKey(asRequest({}), true)).toBe("10.0.0.1");
    expect(clientKey(asRequest({ "x-forwarded-for": "  ,  " }), true)).toBe("10.0.0.1");
  });
});

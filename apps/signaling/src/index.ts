import { brand, type PeerId, type RoomId } from "@passvault/core";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RateLimiter, clientKey } from "./rateLimit.js";
import { RoomFull, RoomRegistry } from "./rooms.js";
import { ShortCodeRegistry } from "./shortCodes.js";
import type { ClientSignalMessage, ServerSignalMessage } from "./signalingTypes.js";

export interface SignalingServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface SignalingOptions {
  /**
   * Read the client address from `X-Forwarded-For`.
   *
   * On only when the server genuinely sits behind a proxy. Trusting the header
   * otherwise lets a client pick its own rate-limit bucket, which is the same
   * as having no rate limit.
   */
  readonly trustProxy?: boolean;
}

/**
 * A signaling message is an SDP offer or an ICE candidate — kilobytes.
 *
 * `ws` allows 100MB by default, which is an invitation to fill this process
 * with a single frame.
 */
const MAX_MESSAGE_BYTES = 256 * 1024;

/** Long enough that a laptop waking from sleep is not mistaken for a dead one. */
const HEARTBEAT_MS = 30_000;

/**
 * Start a signaling server on `port` (0 picks a free one).
 *
 * Exported as a factory so an integration test can drive the real server with
 * real WebSocket clients instead of trusting that it works.
 */
export function startSignalingServer(
  port: number,
  options: SignalingOptions = {}
): Promise<SignalingServer> {
const registry = new RoomRegistry();
const shortCodes = new ShortCodeRegistry();
const trustProxy = options.trustProxy ?? false;
// Two buckets, because the two endpoints cost different things. Creating a
// room reserves memory until it expires; redeeming a code is a lookup.
const roomLimiter = new RateLimiter(20, 0.5);
const codeLimiter = new RateLimiter(60, 2);

const server = createServer((request, response) => {
  if (request.method === "OPTIONS") {
    sendEmpty(response, 204);
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "passvault-signaling",
      // Enough to see the server is doing its job without exposing who is on
      // it: a count, never a room id or a peer id.
      rooms: registry.size(),
      now: new Date().toISOString()
    });
    return;
  }

  if (request.method === "POST" && request.url === "/rooms") {
    if (!roomLimiter.take(clientKey(request, trustProxy))) {
      sendJson(response, 429, { error: "too many requests" });
      return;
    }
    try {
      sendJson(response, 201, registry.createRoom());
    } catch (error) {
      sendJson(response, 503, {
        error: error instanceof RoomFull ? "the server is at capacity" : "could not create a room"
      });
    }
    return;
  }

  // A pairing offer is a URL long enough that nobody will retype it on another
  // device. Exchanging it for eight characters keeps pairing possible when the
  // two devices share no clipboard — which, once one of them is a phone, is
  // the normal case rather than the awkward one.
  if (request.method === "POST" && request.url === "/pairing-codes") {
    if (!codeLimiter.take(clientKey(request, trustProxy))) {
      sendJson(response, 429, { error: "too many requests" });
      return;
    }
    void readJsonBody(request).then((body) => {
      const offer = (body as { offer?: unknown } | undefined)?.offer;
      if (typeof offer !== "string") {
        sendJson(response, 400, { error: "expected an offer string" });
        return;
      }
      try {
        sendJson(response, 201, shortCodes.issue(offer));
      } catch (error) {
        sendJson(response, 503, {
          error: error instanceof Error ? error.message : "could not issue a code"
        });
      }
    });
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/pairing-codes/") === true) {
    // Rate limited above all else here: without it, eight characters can be
    // guessed at line speed rather than one attempt at a time.
    if (!codeLimiter.take(clientKey(request, trustProxy))) {
      sendJson(response, 429, { error: "too many requests" });
      return;
    }
    const offer = shortCodes.redeem(decodeURIComponent(request.url.slice("/pairing-codes/".length)));
    if (offer === undefined) {
      // One message for expired, wrong, and already-used, because telling them
      // apart is only useful to somebody guessing.
      sendJson(response, 404, { error: "That code is not valid. Ask for a new one." });
      return;
    }
    sendJson(response, 200, { offer });
    return;
  }

  sendJson(response, 404, { error: "not found" });
});

const wss = new WebSocketServer({
  server,
  path: "/signal",
  maxPayload: MAX_MESSAGE_BYTES
});

/**
 * Drop connections that stopped answering.
 *
 * A peer whose network vanished leaves a socket the OS never closes, and with
 * it a room that never empties. Without this, those accumulate for the life of
 * the process.
 */
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const alive = (client as WebSocket & { isAlive?: boolean }).isAlive;
    if (alive === false) {
      client.terminate();
      continue;
    }
    (client as WebSocket & { isAlive?: boolean }).isAlive = false;
    client.ping();
  }
}, HEARTBEAT_MS);
// Nothing should be held open by a timer whose only job is cleanup.
heartbeat.unref();

wss.on("connection", (socket) => {
  (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
  socket.on("pong", () => {
    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
  });
  // A socket error that reaches the process is a crash; here it is a hangup.
  socket.on("error", () => socket.terminate());

  let joined:
    | {
        readonly roomId: RoomId;
        readonly peerId: PeerId;
      }
    | undefined;

  socket.on("message", (raw) => {
    try {
      const parsed = parseClientMessage(raw.toString());
      if (parsed === undefined) {
        send(socket, { type: "error", message: "invalid signaling message" });
        return;
      }

      if (parsed.type === "join") {
        const existingPeerIds = registry.join({
          roomId: parsed.roomId,
          inviteToken: parsed.inviteToken,
          peer: {
            peerId: parsed.peerId,
            send: (message) => send(socket, message)
          }
        });
        joined = { roomId: parsed.roomId, peerId: parsed.peerId };
        send(socket, {
          type: "joined",
          roomId: parsed.roomId,
          peerId: parsed.peerId,
          existingPeerIds
        });
        return;
      }

      if (joined === undefined) {
        send(socket, { type: "error", message: "join a room before signaling" });
        return;
      }

      registry.relay({
        roomId: joined.roomId,
        fromPeerId: joined.peerId,
        targetPeerId: parsed.targetPeerId,
        payload: parsed.payload
      });
    } catch (error) {
      send(socket, {
        type: "error",
        message: error instanceof Error ? error.message : "signaling error"
      });
    }
  });

  socket.on("close", () => {
    if (joined !== undefined) {
      registry.leave(joined.roomId, joined.peerId);
    }
  });
});

  return new Promise<SignalingServer>((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(() => server.close(() => done()));
          })
      });
    });
  });
}

function parseClientMessage(raw: string): ClientSignalMessage | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ClientSignalMessage>;
    if (value.type === "join") {
      if (
        typeof value.roomId === "string" &&
        typeof value.inviteToken === "string" &&
        typeof value.peerId === "string"
      ) {
        return {
          type: "join",
          roomId: brand<string, "RoomId">(value.roomId),
          inviteToken: value.inviteToken,
          peerId: brand<string, "PeerId">(value.peerId)
        };
      }
    }

    if (value.type === "signal" && typeof value.targetPeerId === "string") {
      return {
        type: "signal",
        targetPeerId: brand<string, "PeerId">(value.targetPeerId),
        payload: value.payload
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/** Bounded, because an unbounded request body is a way to fill this process. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 8192) {
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function send(socket: WebSocket, message: ServerSignalMessage): void {
  socket.send(JSON.stringify(message));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": "*"
  });
  response.end();
}

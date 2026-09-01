import { assert, brand, type PeerId, type RoomId } from "@passvault/core";
import { randomBytes, randomUUID } from "node:crypto";
import type { Room, SignalingPeer } from "./signalingTypes.js";

/**
 * How long a room nobody has joined is kept.
 *
 * Generous next to a pairing code's ten minutes, because the room has to
 * outlive the code that points at it.
 */
const EMPTY_ROOM_TTL_MS = 20 * 60 * 1000;

/**
 * A ceiling on rooms held at once.
 *
 * Reached only under abuse: a room costs a few hundred bytes, and ordinary use
 * deletes it on the way out. Refusing at a number we chose beats discovering
 * the limit as an out-of-memory kill.
 */
const MAX_ROOMS = 50_000;

export class RoomFull extends Error {}

export class RoomRegistry {
  private readonly rooms = new Map<RoomId, Room>();

  public constructor(private readonly now: () => number = Date.now) {}

  public createRoom(): { readonly roomId: RoomId; readonly inviteToken: string } {
    this.sweep();
    if (this.rooms.size >= MAX_ROOMS) {
      throw new RoomFull("too many rooms are open");
    }

    const roomId = brand<string, "RoomId">(randomUUID());
    const inviteToken = randomBytes(24).toString("base64url");
    this.rooms.set(roomId, {
      id: roomId,
      inviteToken,
      peers: new Map(),
      createdAt: this.now()
    });

    return { roomId, inviteToken };
  }

  public join(input: {
    readonly roomId: RoomId;
    readonly inviteToken: string;
    readonly peer: SignalingPeer;
  }): readonly PeerId[] {
    let room = this.rooms.get(input.roomId);
    if (room === undefined) {
      // Recreated on demand so two paired devices can meet again in the room
      // they paired in, whichever of them arrives first. The token still has to
      // match for the second one, which is what keeps this safe.
      if (this.rooms.size >= MAX_ROOMS) {
        throw new RoomFull("too many rooms are open");
      }
      room = {
        id: input.roomId,
        inviteToken: input.inviteToken,
        peers: new Map(),
        createdAt: this.now()
      };
      this.rooms.set(input.roomId, room);
    }
    assert(room.inviteToken === input.inviteToken, "invite token must match room");

    const existingPeerIds = Array.from(room.peers.keys());
    room.peers.set(input.peer.peerId, input.peer);

    for (const peer of room.peers.values()) {
      if (peer.peerId !== input.peer.peerId) {
        peer.send({ type: "peer-joined", peerId: input.peer.peerId });
      }
    }

    return existingPeerIds;
  }

  public leave(roomId: RoomId, peerId: PeerId): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return;
    }

    room.peers.delete(peerId);
    for (const peer of room.peers.values()) {
      peer.send({ type: "peer-left", peerId });
    }

    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  public relay(input: {
    readonly roomId: RoomId;
    readonly fromPeerId: PeerId;
    readonly targetPeerId: PeerId;
    readonly payload: unknown;
  }): void {
    const room = this.rooms.get(input.roomId);
    assert(room !== undefined, "room must exist before signaling");
    const target = room.peers.get(input.targetPeerId);
    assert(target !== undefined, "target peer must be in room");

    target.send({
      type: "signal",
      fromPeerId: input.fromPeerId,
      payload: input.payload
    });
  }

  /** For the health endpoint, and for tests that assert rooms are collected. */
  public size(): number {
    return this.rooms.size;
  }

  /**
   * Drop rooms that were created and never used.
   *
   * Empty ones only. A room holding a single peer is a device sitting in its
   * rendezvous waiting for the other to appear — exactly the case this must
   * not break.
   */
  public sweep(): number {
    const cutoff = this.now() - EMPTY_ROOM_TTL_MS;
    let removed = 0;
    for (const [roomId, room] of this.rooms) {
      if (room.peers.size === 0 && room.createdAt <= cutoff) {
        this.rooms.delete(roomId);
        removed += 1;
      }
    }
    return removed;
  }
}

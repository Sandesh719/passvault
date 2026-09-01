import type { PeerId, RoomId } from "@passvault/core";

export interface Room {
  readonly id: RoomId;
  readonly inviteToken: string;
  readonly peers: Map<PeerId, SignalingPeer>;
  /**
   * When this room was created, so one nobody ever joins can be collected.
   *
   * A room is deleted the moment its last peer leaves, which covers every
   * normal path. It does not cover a room that is created and then abandoned —
   * a pairing code that is never used, or a request made in a loop by someone
   * who has no intention of connecting.
   */
  readonly createdAt: number;
}

export interface SignalingPeer {
  readonly peerId: PeerId;
  readonly send: (message: ServerSignalMessage) => void;
}

export type ClientSignalMessage =
  | {
      readonly type: "join";
      readonly roomId: RoomId;
      readonly inviteToken: string;
      readonly peerId: PeerId;
    }
  | {
      readonly type: "signal";
      readonly targetPeerId: PeerId;
      readonly payload: unknown;
    };

export type ServerSignalMessage =
  | {
      readonly type: "joined";
      readonly roomId: RoomId;
      readonly peerId: PeerId;
      readonly existingPeerIds: readonly PeerId[];
    }
  | {
      readonly type: "peer-joined";
      readonly peerId: PeerId;
    }
  | {
      readonly type: "peer-left";
      readonly peerId: PeerId;
    }
  | {
      readonly type: "signal";
      readonly fromPeerId: PeerId;
      readonly payload: unknown;
    }
  | {
      readonly type: "error";
      readonly message: string;
    };

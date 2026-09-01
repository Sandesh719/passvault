import { assert, brand, type PeerId, type RoomId } from "@passvault/core";

export type SignalingEvent =
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

export class SignalingClient {
  private socket: WebSocket | undefined;

  public constructor(
    private readonly endpoint: string,
    private readonly onEvent: (event: SignalingEvent) => void
  ) {}

  public connect(input: {
    readonly roomId: RoomId;
    readonly inviteToken: string;
    readonly peerId: PeerId;
  }): void {
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "join",
          roomId: input.roomId,
          inviteToken: input.inviteToken,
          peerId: input.peerId
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const parsed = parseSignalingEvent(String(event.data));
      if (parsed !== undefined) {
        this.onEvent(parsed);
      }
    });

    socket.addEventListener("error", () => {
      this.onEvent({ type: "error", message: "Could not connect to signaling server" });
    });

    socket.addEventListener("close", () => {
      this.socket = undefined;
    });
  }

  public sendSignal(targetPeerId: PeerId, payload: unknown): void {
    assert(this.socket !== undefined, "signaling socket must be connected before sending");
    this.socket.send(
      JSON.stringify({
        type: "signal",
        targetPeerId,
        payload
      })
    );
  }

  public disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

function parseSignalingEvent(raw: string): SignalingEvent | undefined {
  const value = JSON.parse(raw) as Partial<SignalingEvent>;

  if (value.type === "joined") {
    assert(typeof value.roomId === "string", "joined room id must be a string");
    assert(typeof value.peerId === "string", "joined peer id must be a string");
    assert(Array.isArray(value.existingPeerIds), "joined peer list must be an array");
    return {
      type: "joined",
      roomId: brand<string, "RoomId">(value.roomId),
      peerId: brand<string, "PeerId">(value.peerId),
      existingPeerIds: value.existingPeerIds.map((peerId) => brand<string, "PeerId">(String(peerId)))
    };
  }

  if (value.type === "peer-joined" || value.type === "peer-left") {
    assert(typeof value.peerId === "string", "peer event peer id must be a string");
    return {
      type: value.type,
      peerId: brand<string, "PeerId">(value.peerId)
    };
  }

  if (value.type === "signal") {
    assert(typeof value.fromPeerId === "string", "signal source peer id must be a string");
    return {
      type: "signal",
      fromPeerId: brand<string, "PeerId">(value.fromPeerId),
      payload: value.payload
    };
  }

  if (value.type === "error" && typeof value.message === "string") {
    return value as SignalingEvent;
  }

  return undefined;
}

import { parseMessage, type ProtocolErrorCode, type ProtocolMessage } from "@passvault/core";

export class SessionError extends Error {
  public constructor(
    public readonly code: ProtocolErrorCode | "timeout" | "closed",
    message: string
  ) {
    super(message);
    this.name = "SessionError";
  }
}

type AnyMessage = ProtocolMessage & { readonly type: string };
type Handler = (message: AnyMessage) => void;

/**
 * Routes inbound control messages.
 *
 * A session needs two access patterns at once: awaiting a specific reply during
 * the handshake, and reacting to messages that arrive whenever the peer decides
 * to send them. Registered handlers win; anything else is queued so that a
 * message which arrives before its `expect` call is not lost to a race.
 */
export class ControlInbox {
  private readonly handlers = new Map<string, Handler>();
  private readonly queued = new Map<string, AnyMessage[]>();
  private readonly waiters = new Map<string, ((message: AnyMessage) => void)[]>();
  private failure: SessionError | undefined;
  private readonly rejecters = new Set<(error: SessionError) => void>();

  public constructor(private readonly defaultTimeoutMs: number) {}

  /** Feed one raw control-channel payload. Malformed input fails the session. */
  public accept(raw: string): void {
    const outcome = parseMessage(raw);
    if (!outcome.ok) {
      this.fail(new SessionError(outcome.code, outcome.reason));
      return;
    }
    const message = outcome.message as AnyMessage;

    if (message.type === "error") {
      this.fail(new SessionError(message.code, `peer reported: ${message.message}`));
      return;
    }

    const handler = this.handlers.get(message.type);
    if (handler !== undefined) {
      handler(message);
      return;
    }
    const waiter = this.waiters.get(message.type)?.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    const queue = this.queued.get(message.type) ?? [];
    queue.push(message);
    this.queued.set(message.type, queue);
  }

  public on<T extends ProtocolMessage["type"]>(
    type: T,
    handler: (message: Extract<ProtocolMessage, { type: T }>) => void
  ): void {
    this.handlers.set(type, handler as Handler);
    // Drain anything that arrived before the handler was attached.
    const pending = this.queued.get(type);
    this.queued.delete(type);
    for (const message of pending ?? []) {
      handler(message as Extract<ProtocolMessage, { type: T }>);
    }
  }

  /**
   * Await one message of `type`.
   *
   * Always bounded. A peer that connects and then says nothing must not hold a
   * session open forever, so every wait carries a timeout.
   */
  public expect<T extends ProtocolMessage["type"]>(
    type: T,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<Extract<ProtocolMessage, { type: T }>> {
    type Result = Extract<ProtocolMessage, { type: T }>;

    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    if (this.handlers.has(type)) {
      // Handlers take priority over waiters, so a registered handler would
      // consume the very message being awaited and this call would hang until
      // its timeout. Fail immediately and visibly instead.
      return Promise.reject(
        new SessionError("internal", `cannot expect ${type}: a handler is already registered for it`)
      );
    }
    const queued = this.queued.get(type);
    const ready = queued?.shift();
    if (ready !== undefined) {
      return Promise.resolve(ready as Result);
    }

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new SessionError("timeout", `timed out waiting for ${type}`));
      }, timeoutMs);

      const onFail = (error: SessionError): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.rejecters.delete(onFail);
        const list = this.waiters.get(type);
        const index = list?.indexOf(settle) ?? -1;
        if (list !== undefined && index >= 0) {
          list.splice(index, 1);
        }
      };
      const settle = (message: AnyMessage): void => {
        cleanup();
        resolve(message as Result);
      };

      this.rejecters.add(onFail);
      const list = this.waiters.get(type) ?? [];
      list.push(settle);
      this.waiters.set(type, list);
    });
  }

  public fail(error: SessionError): void {
    this.failure ??= error;
    for (const reject of [...this.rejecters]) {
      reject(error);
    }
    this.rejecters.clear();
  }

  public get failed(): SessionError | undefined {
    return this.failure;
  }
}

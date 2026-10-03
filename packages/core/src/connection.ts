/**
 * How a device reaches other devices.
 *
 * Here rather than in the desktop app's IPC contract because it is not about
 * IPC: a phone has no IPC and still has to be told which server to meet peers
 * on and which relay to fall back to. Both platforms store exactly this.
 */
export interface ConnectionSettings {
  readonly serverHost: string;
  readonly turnUrl?: string;
  readonly turnUsername?: string;
  readonly turnCredential?: string;
}

/**
 * An ICE server, spelled out rather than borrowed from the DOM.
 *
 * The code that stores and forwards these has no DOM types — and should not
 * need them to describe a value it never inspects. Structurally identical to
 * `RTCIceServer`, so whichever side owns WebRTC can hand it straight over.
 */
export interface IceServer {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

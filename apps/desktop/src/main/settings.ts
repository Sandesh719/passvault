import { isValidServerHost, normalizeServerHost } from "@passvault/core";
import type { SqlDatabase } from "@passvault/storage-node";
import type { ConnectionSettings, IceServer } from "../shared/api.js";

/**
 * Where this device meets other devices.
 *
 * Two devices in different places can only find each other through a server
 * they both know about. Baking that address into the build made "anywhere in
 * the world" mean "anywhere on this laptop", so it is a setting — and the app
 * shows it rather than hiding it, because a person pairing two devices needs to
 * be able to see that both are pointed at the same place.
 *
 * The shape lives in the IPC contract; the renderer edits exactly this.
 */
export type { ConnectionSettings } from "../shared/api.js";

const KEY = "connection";

export class SettingsStore {
  private cached: ConnectionSettings | undefined;

  public constructor(
    private readonly db: SqlDatabase,
    private readonly fallbackHost: string
  ) {}

  public get(): ConnectionSettings {
    if (this.cached !== undefined) {
      return this.cached;
    }
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as
      | { value: string }
      | undefined;

    let stored: Partial<ConnectionSettings> = {};
    if (row !== undefined) {
      try {
        stored = JSON.parse(row.value) as Partial<ConnectionSettings>;
      } catch {
        // A corrupted preference should not stop the app from starting; the
        // built-in default is always usable.
      }
    }

    this.cached = {
      serverHost:
        typeof stored.serverHost === "string" && isValidServerHost(stored.serverHost)
          ? stored.serverHost
          : this.fallbackHost,
      ...(typeof stored.turnUrl === "string" && stored.turnUrl.length > 0
        ? { turnUrl: stored.turnUrl }
        : {}),
      ...(typeof stored.turnUsername === "string" ? { turnUsername: stored.turnUsername } : {}),
      ...(typeof stored.turnCredential === "string" ? { turnCredential: stored.turnCredential } : {})
    };
    return this.cached;
  }

  public save(next: ConnectionSettings): ConnectionSettings {
    // Accepts a pasted URL, not just a bare host: somebody who just ran
    // `curl https://sync.example.org/health` will paste exactly that.
    const host = normalizeServerHost(next.serverHost);
    if (host === undefined) {
      throw new Error(
        `Could not read "${next.serverHost.trim()}" as a server address. It should look like sync.example.org.`
      );
    }
    // A relay URL must be a turn: or turns: one. Anything else silently fails
    // inside the WebRTC stack much later, where it looks like a network fault.
    const turnUrl = next.turnUrl?.trim() ?? "";
    if (turnUrl.length > 0 && !/^turns?:/iu.test(turnUrl)) {
      throw new Error(`"${turnUrl}" is not a relay address. It should start with turn: or turns:.`);
    }

    const settings: ConnectionSettings = {
      serverHost: host,
      ...(turnUrl.length > 0 ? { turnUrl } : {}),
      ...(next.turnUsername === undefined ? {} : { turnUsername: next.turnUsername.trim() }),
      ...(next.turnCredential === undefined ? {} : { turnCredential: next.turnCredential })
    };

    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run({ key: KEY, value: JSON.stringify(settings) });
    this.cached = settings;
    return settings;
  }

  /**
   * What the renderer hands to WebRTC.
   *
   * STUN alone lets most pairs of devices find a direct path. The relay is for
   * the networks where that fails — symmetric NAT, restrictive corporate
   * firewalls — and without one those devices simply never connect.
   */
  public iceServers(): IceServer[] {
    const settings = this.get();
    const servers: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    if (settings.turnUrl !== undefined) {
      servers.push({
        urls: settings.turnUrl,
        ...(settings.turnUsername === undefined ? {} : { username: settings.turnUsername }),
        ...(settings.turnCredential === undefined ? {} : { credential: settings.turnCredential })
      });
    }
    return servers;
  }
}

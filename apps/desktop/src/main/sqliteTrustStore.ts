import { brand, type DeviceId } from "@passvault/core";
import type { PairedDevice, TrustStore } from "@passvault/identity";
import type { SqlDatabase } from "@passvault/storage-node";

interface DeviceRow {
  readonly id: string;
  readonly public_key: Uint8Array;
  readonly name: string;
  readonly trust: string;
  readonly paired_at: string;
  readonly last_seen_at: string | null;
}

/**
 * Trust store over the `devices` table the schema already defines.
 *
 * Pinned public keys live beside the revision DAG because they are exactly as
 * durable: a device that reinstalls loses its key and must be re-paired, which
 * is the intended behaviour rather than an inconvenience to work around.
 */
export function createSqliteTrustStore(db: SqlDatabase): TrustStore {
  return {
    pair: async (device) => {
      db.prepare(
        `INSERT INTO devices (id, public_key, name, trust, paired_at, last_seen_at)
         VALUES (@id, @publicKey, @name, 'paired', @pairedAt, NULL)
         ON CONFLICT(id) DO UPDATE SET
           public_key = excluded.public_key,
           name = excluded.name,
           trust = 'paired',
           paired_at = excluded.paired_at`
      ).run({
        id: device.deviceId,
        publicKey: device.publicKey,
        name: device.name,
        pairedAt: device.pairedAt.toISOString()
      });
    },

    get: async (deviceId) => {
      const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as
        | DeviceRow
        | undefined;
      return row === undefined ? undefined : toPairedDevice(row);
    },

    list: async () => {
      const rows = db.prepare("SELECT * FROM devices ORDER BY paired_at DESC").all() as DeviceRow[];
      return rows.map(toPairedDevice);
    },

    revoke: async (deviceId) => {
      db.prepare("UPDATE devices SET trust = 'revoked' WHERE id = ?").run(deviceId);
    },

    markSeen: async (deviceId, at) => {
      db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at.toISOString(), deviceId);
    }
  };
}

function toPairedDevice(row: DeviceRow): PairedDevice {
  return {
    deviceId: brand<string, "DeviceId">(row.id) as DeviceId,
    publicKey: new Uint8Array(row.public_key),
    name: row.name,
    trust: row.trust === "revoked" ? "revoked" : "paired",
    pairedAt: new Date(row.paired_at),
    ...(row.last_seen_at === null ? {} : { lastSeenAt: new Date(row.last_seen_at) })
  };
}

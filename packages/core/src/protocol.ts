import { brand, type DeviceId, type RevisionId, type Sha256Hex, type VaultId } from "./types.js";

export const PROTOCOL_VERSION = 1;

/**
 * Hard caps on anything a peer can make us allocate.
 *
 * Every field below arrives from the other end of a data channel. Without
 * bounds, a single well-formed message could ask us to build a ten-million
 * node graph or buffer a gigabyte before we ever decide whether we trust the
 * sender. These are generous for real vaults and fatal for abuse.
 */
export const LIMITS = {
  maxHistoryNodes: 100_000,
  maxParentsPerRevision: 64,
  maxWantedRevisions: 100_000,
  maxRevisionBytes: 512 * 1024 * 1024,
  maxChunks: 262_144,
  maxStringLength: 4096
} as const;

export type ProtocolMessage =
  | HelloMessage
  | AuthMessage
  | VaultSummaryMessage
  | HistorySummaryMessage
  | WantRevisionsMessage
  | RevisionHeaderMessage
  | RevisionAckMessage
  | TransferCancelMessage
  | SyncCompleteMessage
  | ByeMessage
  | ErrorMessage;

/**
 * First message on the control channel. Establishes version and identity, and
 * issues this device's challenge nonce.
 *
 * The public key travels with the id so the receiver can check that the id is
 * genuinely its hash, rather than taking a claimed identity at face value.
 */
export interface HelloMessage {
  readonly type: "hello";
  readonly protocolVersion: number;
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  /** base64 ed25519 public key */
  readonly publicKey: string;
  /** base64 nonce the peer must sign to prove it holds the matching private key */
  readonly nonce: string;
}

/**
 * Proof of possession: a signature over the challenge the *peer* issued.
 *
 * Signing their nonce rather than our own is what stops a recording of an
 * earlier session from being replayed here.
 */
export interface AuthMessage {
  readonly type: "auth";
  /** base64 ed25519 signature */
  readonly signature: string;
}

/**
 * Where this peer stands on one vault, before any history is exchanged.
 *
 * `headRevisionId` is absent when the peer holds nothing yet. A freshly paired
 * device is exactly that, and it is the most common way a session starts, so an
 * empty side is an ordinary state rather than an error.
 */
export interface VaultSummaryMessage {
  readonly type: "vault-summary";
  readonly vaultId: VaultId;
  /** Carried so a device with no vault can adopt this one wholesale. */
  readonly vaultName: string;
  readonly headRevisionId?: RevisionId;
  readonly revisionCount: number;
}

export interface HistorySummaryEntry {
  readonly revisionId: RevisionId;
  readonly hash: Sha256Hex;
  readonly sizeBytes: number;
  readonly parentIds: readonly RevisionId[];
}

/**
 * The peer's DAG, ids and parents only.
 *
 * This is what makes divergence detection possible without decryption: the
 * receiver can compute the merge base and the missing set from shape alone.
 */
export interface HistorySummaryMessage {
  readonly type: "history-summary";
  readonly vaultId: VaultId;
  readonly revisions: readonly HistorySummaryEntry[];
}

export interface WantRevisionsMessage {
  readonly type: "want-revisions";
  readonly vaultId: VaultId;
  /** Topologically ordered, parents first, so the receiver never holds a dangling edge. */
  readonly revisionIds: readonly RevisionId[];
}

/**
 * Announces a transfer about to start on the bulk channel.
 *
 * `transferSeq` is what binary frames carry instead of a full revision id —
 * four bytes rather than thirty-six, on every chunk.
 */
export interface RevisionHeaderMessage {
  readonly type: "revision-header";
  readonly transferSeq: number;
  readonly vaultId: VaultId;
  readonly revisionId: RevisionId;
  readonly hash: Sha256Hex;
  readonly sizeBytes: number;
  readonly parentIds: readonly RevisionId[];
  readonly totalChunks: number;
  readonly message?: string;
}

export interface RevisionAckMessage {
  readonly type: "revision-ack";
  readonly revisionId: RevisionId;
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface TransferCancelMessage {
  readonly type: "transfer-cancel";
  readonly transferSeq: number;
  readonly reason: string;
}

/** This peer has sent everything the other asked for. */
export interface SyncCompleteMessage {
  readonly type: "sync-complete";
  readonly vaultId: VaultId;
}

export interface ByeMessage {
  readonly type: "bye";
}

export type ProtocolErrorCode =
  | "unsupported-version"
  | "unauthorized"
  | "unknown-vault"
  | "malformed-message"
  | "limit-exceeded"
  | "internal";

export interface ErrorMessage {
  readonly type: "error";
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

export function encodeMessage(message: ProtocolMessage): string {
  return JSON.stringify(message);
}

export type ParseOutcome =
  | { readonly ok: true; readonly message: ProtocolMessage }
  | { readonly ok: false; readonly code: ProtocolErrorCode; readonly reason: string };

/**
 * Parse and validate one control-channel message.
 *
 * Returns an outcome rather than throwing, and never trusts a field it has not
 * checked. Anything reaching here came from another device; a peer that is
 * buggy or hostile should produce a protocol error, not an exception halfway
 * through mutating our state.
 */
export function parseMessage(raw: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return malformed("message is not valid JSON");
  }
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return malformed("message has no type");
  }

  switch (value["type"]) {
    case "hello":
      return parseHello(value);
    case "auth":
      return parseAuth(value);
    case "vault-summary":
      return parseVaultSummary(value);
    case "history-summary":
      return parseHistorySummary(value);
    case "want-revisions":
      return parseWantRevisions(value);
    case "revision-header":
      return parseRevisionHeader(value);
    case "revision-ack":
      return parseRevisionAck(value);
    case "transfer-cancel":
      return parseTransferCancel(value);
    case "sync-complete":
      return parseSyncComplete(value);
    case "bye":
      return { ok: true, message: { type: "bye" } };
    case "error":
      return parseError(value);
    default:
      return malformed(`unknown message type ${String(value["type"])}`);
  }
}

function parseHello(value: Record<string, unknown>): ParseOutcome {
  const deviceId = str(value["deviceId"]);
  const deviceName = str(value["deviceName"]);
  const publicKey = str(value["publicKey"]);
  const nonce = str(value["nonce"]);
  const protocolVersion = value["protocolVersion"];
  if (deviceId === undefined || deviceName === undefined) {
    return malformed("hello requires deviceId and deviceName");
  }
  if (publicKey === undefined || nonce === undefined) {
    return malformed("hello requires publicKey and nonce");
  }
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return malformed("hello requires an integer protocolVersion");
  }
  return {
    ok: true,
    message: {
      type: "hello",
      protocolVersion,
      deviceId: brand<string, "DeviceId">(deviceId),
      deviceName,
      publicKey,
      nonce
    }
  };
}

function parseAuth(value: Record<string, unknown>): ParseOutcome {
  const signature = str(value["signature"]);
  if (signature === undefined) {
    return malformed("auth requires a signature");
  }
  return { ok: true, message: { type: "auth", signature } };
}

function parseVaultSummary(value: Record<string, unknown>): ParseOutcome {
  const vaultId = str(value["vaultId"]);
  const vaultName = str(value["vaultName"]) ?? "Shared vault";
  const headRevisionId = str(value["headRevisionId"]);
  const revisionCount = value["revisionCount"];
  if (vaultId === undefined) {
    return malformed("vault-summary requires vaultId");
  }
  if (!isCount(revisionCount)) {
    return malformed("vault-summary requires a non-negative revisionCount");
  }
  return {
    ok: true,
    message: {
      type: "vault-summary",
      vaultId: brand<string, "VaultId">(vaultId),
      vaultName,
      revisionCount,
      ...(headRevisionId === undefined
        ? {}
        : { headRevisionId: brand<string, "RevisionId">(headRevisionId) })
    }
  };
}

function parseHistorySummary(value: Record<string, unknown>): ParseOutcome {
  const vaultId = str(value["vaultId"]);
  const rows = value["revisions"];
  if (vaultId === undefined) {
    return malformed("history-summary requires vaultId");
  }
  if (!Array.isArray(rows)) {
    return malformed("history-summary requires a revisions array");
  }
  if (rows.length > LIMITS.maxHistoryNodes) {
    return exceeded(`history-summary carries ${rows.length} revisions`);
  }

  const revisions: HistorySummaryEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      return malformed("history-summary entry is not an object");
    }
    const revisionId = str(row["revisionId"]);
    const hash = hex64(row["hash"]);
    const sizeBytes = row["sizeBytes"];
    const parents = row["parentIds"];
    if (revisionId === undefined || hash === undefined) {
      return malformed("history-summary entry requires revisionId and a sha256 hash");
    }
    if (!isCount(sizeBytes) || sizeBytes > LIMITS.maxRevisionBytes) {
      return malformed("history-summary entry has an invalid sizeBytes");
    }
    if (!Array.isArray(parents)) {
      return malformed("history-summary entry requires parentIds");
    }
    if (parents.length > LIMITS.maxParentsPerRevision) {
      return exceeded(`revision ${revisionId} declares ${parents.length} parents`);
    }
    const parentIds: RevisionId[] = [];
    for (const parent of parents) {
      const parentId = str(parent);
      if (parentId === undefined) {
        return malformed("parentIds must be strings");
      }
      parentIds.push(brand<string, "RevisionId">(parentId));
    }
    revisions.push({
      revisionId: brand<string, "RevisionId">(revisionId),
      hash,
      sizeBytes,
      parentIds
    });
  }

  return {
    ok: true,
    message: { type: "history-summary", vaultId: brand<string, "VaultId">(vaultId), revisions }
  };
}

function parseWantRevisions(value: Record<string, unknown>): ParseOutcome {
  const vaultId = str(value["vaultId"]);
  const ids = value["revisionIds"];
  if (vaultId === undefined) {
    return malformed("want-revisions requires vaultId");
  }
  if (!Array.isArray(ids)) {
    return malformed("want-revisions requires a revisionIds array");
  }
  if (ids.length > LIMITS.maxWantedRevisions) {
    return exceeded(`want-revisions asks for ${ids.length} revisions`);
  }
  const revisionIds: RevisionId[] = [];
  for (const id of ids) {
    const revisionId = str(id);
    if (revisionId === undefined) {
      return malformed("revisionIds must be strings");
    }
    revisionIds.push(brand<string, "RevisionId">(revisionId));
  }
  return {
    ok: true,
    message: { type: "want-revisions", vaultId: brand<string, "VaultId">(vaultId), revisionIds }
  };
}

function parseRevisionHeader(value: Record<string, unknown>): ParseOutcome {
  const vaultId = str(value["vaultId"]);
  const revisionId = str(value["revisionId"]);
  const hash = hex64(value["hash"]);
  const transferSeq = value["transferSeq"];
  const sizeBytes = value["sizeBytes"];
  const totalChunks = value["totalChunks"];
  const parents = value["parentIds"];
  const message = value["message"];

  if (vaultId === undefined || revisionId === undefined || hash === undefined) {
    return malformed("revision-header requires vaultId, revisionId and a sha256 hash");
  }
  if (!isCount(transferSeq)) {
    return malformed("revision-header requires a transferSeq");
  }
  if (!isCount(sizeBytes) || sizeBytes > LIMITS.maxRevisionBytes) {
    return exceeded("revision-header declares an unacceptable sizeBytes");
  }
  if (!isCount(totalChunks) || totalChunks > LIMITS.maxChunks) {
    return exceeded("revision-header declares an unacceptable totalChunks");
  }
  if (!Array.isArray(parents) || parents.length > LIMITS.maxParentsPerRevision) {
    return malformed("revision-header requires a bounded parentIds array");
  }
  const parentIds: RevisionId[] = [];
  for (const parent of parents) {
    const parentId = str(parent);
    if (parentId === undefined) {
      return malformed("parentIds must be strings");
    }
    parentIds.push(brand<string, "RevisionId">(parentId));
  }
  if (message !== undefined && str(message) === undefined) {
    return malformed("revision-header message must be a bounded string");
  }

  return {
    ok: true,
    message: {
      type: "revision-header",
      transferSeq,
      vaultId: brand<string, "VaultId">(vaultId),
      revisionId: brand<string, "RevisionId">(revisionId),
      hash,
      sizeBytes,
      parentIds,
      totalChunks,
      ...(typeof message === "string" ? { message } : {})
    }
  };
}

function parseRevisionAck(value: Record<string, unknown>): ParseOutcome {
  const revisionId = str(value["revisionId"]);
  const accepted = value["accepted"];
  const reason = value["reason"];
  if (revisionId === undefined || typeof accepted !== "boolean") {
    return malformed("revision-ack requires revisionId and accepted");
  }
  return {
    ok: true,
    message: {
      type: "revision-ack",
      revisionId: brand<string, "RevisionId">(revisionId),
      accepted,
      ...(typeof reason === "string" ? { reason: reason.slice(0, LIMITS.maxStringLength) } : {})
    }
  };
}

function parseTransferCancel(value: Record<string, unknown>): ParseOutcome {
  const transferSeq = value["transferSeq"];
  const reason = str(value["reason"]) ?? "cancelled";
  if (!isCount(transferSeq)) {
    return malformed("transfer-cancel requires a transferSeq");
  }
  return { ok: true, message: { type: "transfer-cancel", transferSeq, reason } };
}

function parseSyncComplete(value: Record<string, unknown>): ParseOutcome {
  const vaultId = str(value["vaultId"]);
  if (vaultId === undefined) {
    return malformed("sync-complete requires vaultId");
  }
  return { ok: true, message: { type: "sync-complete", vaultId: brand<string, "VaultId">(vaultId) } };
}

function parseError(value: Record<string, unknown>): ParseOutcome {
  const code = str(value["code"]) ?? "internal";
  const message = str(value["message"]) ?? "";
  const known: readonly string[] = [
    "unsupported-version",
    "unauthorized",
    "unknown-vault",
    "malformed-message",
    "limit-exceeded",
    "internal"
  ];
  return {
    ok: true,
    message: {
      type: "error",
      code: (known.includes(code) ? code : "internal") as ProtocolErrorCode,
      message
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string that is present, non-empty, and short enough to be worth keeping. */
function str(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.maxStringLength) {
    return undefined;
  }
  return value;
}

function hex64(value: unknown): Sha256Hex | undefined {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return undefined;
  }
  return brand<string, "Sha256Hex">(value) as Sha256Hex;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function malformed(reason: string): ParseOutcome {
  return { ok: false, code: "malformed-message", reason };
}

function exceeded(reason: string): ParseOutcome {
  return { ok: false, code: "limit-exceeded", reason };
}

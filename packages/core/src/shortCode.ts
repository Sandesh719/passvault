/**
 * The alphabet and shape of a short pairing code.
 *
 * Shared by the signaling server that issues codes and the app that types them
 * back in, because two implementations of "which characters count" is one
 * implementation too many.
 */

/**
 * Crockford's alphabet minus the characters that change identity between one
 * screen and another keyboard. No I, L, O or U: nothing that collides with 1 or
 * 0, and nothing that spells anything unfortunate.
 */
export const SHORT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SHORT_CODE_LENGTH = 8;

/** `4F7K-2QX9` reads back to a person more reliably than `4F7K2QX9`. */
export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Accept what people actually type: lower case, missing or extra dashes,
 * surrounding whitespace, and the very substitutions the alphabet was chosen to
 * make harmless.
 */
export function normalizeShortCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** Is this a short code rather than a full pairing link? */
export function looksLikeShortCode(raw: string): boolean {
  return parseShortCode(raw) !== undefined;
}

/**
 * A code, and optionally the server holding it.
 *
 * A bare code is a receipt with no address on it: it means nothing except to
 * the server that issued it. That is fine while both devices use the same
 * server and useless the moment they do not, which is why a code can carry
 * where to redeem it — `4F7K-2QX9@sync.example.org`.
 *
 * The host is only needed when the two devices are set to different servers.
 * Typing it is the price of that, and it is a price only self-hosters pay.
 */
export interface ParsedShortCode {
  readonly code: string;
  readonly host?: string;
}

export function formatQualifiedShortCode(code: string, host: string): string {
  return `${normalizeShortCode(code).length === SHORT_CODE_LENGTH ? formatShortCode(normalizeShortCode(code)) : code}@${host}`;
}

/**
 * Parse what someone typed into the connect box.
 *
 * Returns undefined for anything that is not a code — a pairing link most of
 * all, which must be decoded locally rather than sent to a server to redeem.
 */
export function parseShortCode(raw: string): ParsedShortCode | undefined {
  const trimmed = raw.trim();
  // A link carries its own server inside it and never needs qualifying, so it
  // must not be mistaken for a code with an "@" in it.
  if (trimmed.includes("://")) {
    return undefined;
  }

  const at = trimmed.lastIndexOf("@");
  const codePart = at === -1 ? trimmed : trimmed.slice(0, at);
  const hostPart = at === -1 ? undefined : trimmed.slice(at + 1).trim();

  const code = normalizeShortCode(codePart);
  if (
    code.length !== SHORT_CODE_LENGTH ||
    ![...code].every((character) => SHORT_CODE_ALPHABET.includes(character))
  ) {
    return undefined;
  }
  if (hostPart === undefined) {
    return { code };
  }
  return isValidServerHost(hostPart) ? { code, host: hostPart.toLowerCase() } : undefined;
}

/**
 * `host` or `host:port` — a name, not a URL.
 *
 * Deliberately narrow. What is typed here becomes a server this device will
 * talk to, so anything carrying a path, a scheme, credentials or a query is
 * refused rather than interpreted generously.
 */
export function isValidServerHost(host: string): boolean {
  const match = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/iu.exec(
    host.trim()
  );
  if (match === null) {
    return false;
  }
  const port = host.split(":")[1];
  return port === undefined || (Number(port) > 0 && Number(port) <= 65535);
}

/**
 * Turn whatever someone pasted into a bare host.
 *
 * People arrive here having just run `curl https://sync.example.org/health`, or
 * having copied the address out of a browser. Refusing `https://sync.example.org`
 * and telling them to "use something like sync.example.org" is a lecture about
 * a difference the app is perfectly capable of resolving itself.
 *
 * Strips the scheme and any path — a deployment under a subpath is not
 * something this supports in the first place, so keeping the path would only
 * store an address that cannot work. Returns undefined if what is left is not
 * a host.
 */
export function normalizeServerHost(raw: string): string | undefined {
  const withoutScheme = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const host = (withoutScheme.split(/[/?#]/u)[0] ?? "").toLowerCase();
  return isValidServerHost(host) ? host : undefined;
}

/**
 * Whether a server is reached in the clear.
 *
 * Only the loopback address and `.local` names are, because those never leave
 * the machine or the LAN. Everything else is on the public internet and gets
 * TLS — not as a preference but because the pairing offer would otherwise be
 * modifiable in flight by anyone on the path.
 */
export function isLocalHost(host: string): boolean {
  const name = (host.split(":")[0] ?? "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name.endsWith(".local");
}

export function httpUrlFor(host: string): string {
  return `${isLocalHost(host) ? "http" : "https"}://${host}`;
}

export function signalUrlFor(host: string): string {
  return `${isLocalHost(host) ? "ws" : "wss"}://${host}/signal`;
}

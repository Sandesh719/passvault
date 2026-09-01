import {
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  formatShortCode,
  normalizeShortCode
} from "@passvault/core";
import { randomInt } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;
/** A pairing offer is a URL with a key in it, not a document. */
const MAX_OFFER_BYTES = 2048;

export interface IssuedShortCode {
  readonly code: string;
  readonly expiresAt: string;
}

/**
 * Short, typable stand-ins for a pairing offer.
 *
 * What this holds is exactly what a QR code would carry: a public key, a room
 * id, and an invite token. None of it is vault data and none of it is a secret
 * — possession of an offer buys the right to *attempt* a connection, and the
 * short authentication string is what actually gates trust. That is what makes
 * a code this short safe: guessing one lets someone knock on a door where they
 * will still be asked for a number they have no way to know.
 *
 * Codes are single-use and expire in ten minutes, so guessing has one narrow
 * window rather than an open-ended one.
 */
export class ShortCodeRegistry {
  private readonly entries = new Map<string, { readonly offer: string; readonly expiresAt: number }>();

  public constructor(private readonly now: () => number = Date.now) {}

  public issue(offer: string): IssuedShortCode {
    if (offer.length === 0 || offer.length > MAX_OFFER_BYTES) {
      throw new Error("pairing offer is missing or too large");
    }
    this.sweep();
    if (this.entries.size >= MAX_ENTRIES) {
      throw new Error("too many pairing codes are outstanding");
    }

    let code = this.generate();
    while (this.entries.has(code)) {
      code = this.generate();
    }

    const expiresAt = this.now() + TTL_MS;
    this.entries.set(code, { offer, expiresAt });
    return { code: formatShortCode(code), expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Redeem a code. Single use, so a code that leaks afterwards buys nothing. */
  public redeem(raw: string): string | undefined {
    this.sweep();
    const entry = this.entries.get(normalizeShortCode(raw));
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(normalizeShortCode(raw));
    return entry.offer;
  }

  private generate(): string {
    let code = "";
    for (let index = 0; index < SHORT_CODE_LENGTH; index += 1) {
      code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
    }
    return code;
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(code);
      }
    }
  }
}

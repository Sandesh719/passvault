/**
 * Credentials for opening KDBX databases during an interpretation.
 *
 * These exist only for the duration of one merge or diff call. Nothing here is
 * ever written to the metadata store, the blob store, or the event log.
 *
 * A caveat worth stating plainly: JavaScript strings cannot be reliably wiped
 * from memory, so a password passed as a string may persist until garbage
 * collection. The mitigations available to us are the ones this design already
 * takes — never persist it, never log it, and keep the window short by
 * resolving credentials at call time rather than holding them in app state.
 */
export interface KdbxOpenCredentials {
  readonly password?: string;
  readonly keyFile?: ArrayBuffer;
}

export interface KdbxCredentialSet {
  readonly local: KdbxOpenCredentials;
  /** One entry per incoming revision, in the same order as the request. */
  readonly incoming: readonly KdbxOpenCredentials[];
  /** Credentials for the merge output. Defaults to `local` when omitted. */
  readonly output?: KdbxOpenCredentials;
}

/** Convenience for the common case: every file opens with the same password. */
export function uniformCredentials(password: string, incomingCount: number): KdbxCredentialSet {
  return {
    local: { password },
    incoming: Array.from({ length: incomingCount }, () => ({ password }))
  };
}

/**
 * Does this look like a KeePass database at all?
 *
 * Not decryption, and not a guarantee: it reads the eight-byte header every
 * KDBX file begins with and nothing else. No credentials are involved and no
 * content is interpreted, so this stays on the safe side of the boundary.
 *
 * It exists because nothing else in the system can tell. The design treats a
 * vault as opaque bytes on purpose, which means a mistyped path or a mis-tapped
 * file picker is accepted without complaint and then faithfully synchronised to
 * every other device. Catching it at the moment someone chooses the file is the
 * only place the mistake is still obvious to them.
 */
export function looksLikeKdbx(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  // 0x9AA2D903 marks a KeePass file; the second word distinguishes KDBX 2+
  // from the much older KDB format, which this cannot merge.
  return view.getUint32(0, true) === 0x9aa2d903 && view.getUint32(4, true) === 0xb54bfb67;
}

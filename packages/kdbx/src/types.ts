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

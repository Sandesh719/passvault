import type * as kw from "kdbxweb";
import {
  assert,
  emptyVaultDiff,
  mergeVaultDiffs,
  type DiffResult,
  type InterpretationRequest,
  type InterpretationResult,
  type RevisionInterpreter,
  type VaultDiff
} from "@passvault/core";
import { kdbxweb } from "./kdbxweb.js";
import { registerArgon2 } from "./argon2.js";
import { diffSnapshots, snapshotDatabase, toArrayBuffer } from "./snapshot.js";
import type { KdbxCredentialSet, KdbxOpenCredentials } from "./types.js";

/**
 * The only component in this system that decrypts a vault.
 *
 * It takes bytes and returns bytes, and imports nothing from `node:fs` or any
 * storage package. That is deliberate: with no filesystem reachable from here,
 * decrypted material cannot leak to disk from inside the decryption boundary
 * even by accident.
 */
export class KdbxInterpreter implements RevisionInterpreter<KdbxCredentialSet> {
  public async merge(request: InterpretationRequest<KdbxCredentialSet>): Promise<InterpretationResult> {
    const credentials = request.credentials;
    if (credentials === undefined) {
      return { kind: "needs-credentials", reason: "KDBX merge requires credentials for every database." };
    }
    if (request.incoming.length === 0) {
      return { kind: "merge-failed", reason: "No incoming revisions to merge." };
    }
    if (credentials.incoming.length !== request.incoming.length) {
      return {
        kind: "needs-credentials",
        reason: `Expected ${request.incoming.length} incoming credential set(s), received ${credentials.incoming.length}.`
      };
    }

    registerArgon2();
    try {
      const localDb = await kdbxweb.Kdbx.load(
        toArrayBuffer(request.local.bytes),
        toCredentials(credentials.local)
      );

      for (const [index, incoming] of request.incoming.entries()) {
        const incomingCredentials = credentials.incoming[index];
        assert(incomingCredentials !== undefined, "missing credentials for an incoming revision");
        const incomingDb = await kdbxweb.Kdbx.load(
          toArrayBuffer(incoming.bytes),
          toCredentials(incomingCredentials)
        );
        localDb.merge(incomingDb);
      }

      const outputCredentials = credentials.output ?? credentials.local;
      if (credentials.output !== undefined) {
        localDb.credentials = toCredentials(credentials.output);
      }

      const saved = await localDb.save();
      // Re-open what we are about to hand back. A merge that produces bytes we
      // cannot read again would be silently unrecoverable once promoted.
      await kdbxweb.Kdbx.load(saved, toCredentials(outputCredentials));

      return {
        kind: "merge-succeeded",
        bytes: new Uint8Array(saved),
        parentRevisionIds: [request.local.revisionId, ...request.incoming.map((item) => item.revisionId)]
      };
    } catch (error) {
      return { kind: "merge-failed", reason: describe(error) };
    }
  }

  public async diff(request: InterpretationRequest<KdbxCredentialSet>): Promise<DiffResult> {
    const credentials = request.credentials;
    if (credentials === undefined) {
      return { kind: "needs-credentials", reason: "KDBX diff requires credentials for every database." };
    }
    if (credentials.incoming.length !== request.incoming.length) {
      return {
        kind: "needs-credentials",
        reason: `Expected ${request.incoming.length} incoming credential set(s), received ${credentials.incoming.length}.`
      };
    }

    registerArgon2();
    try {
      const localDb = await kdbxweb.Kdbx.load(
        toArrayBuffer(request.local.bytes),
        toCredentials(credentials.local)
      );
      const baseSnapshot = await snapshotDatabase(localDb);

      let aggregate: VaultDiff = emptyVaultDiff;
      for (const [index, incoming] of request.incoming.entries()) {
        const incomingCredentials = credentials.incoming[index];
        assert(incomingCredentials !== undefined, "missing credentials for an incoming revision");
        const incomingDb = await kdbxweb.Kdbx.load(
          toArrayBuffer(incoming.bytes),
          toCredentials(incomingCredentials)
        );
        aggregate = mergeVaultDiffs(aggregate, diffSnapshots(baseSnapshot, await snapshotDatabase(incomingDb)));
      }
      return { kind: "diff-ready", diff: aggregate };
    } catch (error) {
      return { kind: "diff-failed", reason: describe(error) };
    }
  }
}

function toCredentials(input: KdbxOpenCredentials): kw.Credentials {
  assert(
    input.password !== undefined || input.keyFile !== undefined,
    "KDBX credentials must include a password or key file"
  );
  return new kdbxweb.Credentials(
    input.password === undefined ? null : kdbxweb.ProtectedValue.fromString(input.password),
    input.keyFile ?? null
  );
}

/**
 * kdbxweb reports a wrong password as a typed error. Surfacing that distinctly
 * matters because "you typed the wrong password" and "this file is corrupt"
 * lead the user to completely different actions.
 */
function describe(error: unknown): string {
  if (error instanceof kdbxweb.KdbxError) {
    if (error.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
      return "Wrong password or key file for one of the selected databases.";
    }
    return `KDBX error (${error.code}): ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unknown KDBX failure";
}

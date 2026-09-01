import kdbxwebDefault from "kdbxweb";

/**
 * The single import site for kdbxweb.
 *
 * kdbxweb is CommonJS. Under Node's ESM loader a namespace import
 * (`import * as kdbxweb`) yields an object whose properties are all undefined —
 * the real exports sit under `.default`. Bundlers paper over this, so the
 * mistake typechecks, passes tests run through Vite, and then fails only at
 * runtime in the packaged app.
 *
 * A default import is the form that behaves the same in both worlds, so it is
 * done exactly once here and everything else imports from this module.
 */
export const kdbxweb = kdbxwebDefault as unknown as typeof import("kdbxweb");

export default kdbxweb;

import type * as kw from "kdbxweb";
import { kdbxweb } from "./kdbxweb.js";
import { brand, type RevisionId, type VaultId } from "@passvault/core";
import { beforeAll, describe, expect, it } from "vitest";
import { argon2Impl, registerArgon2 } from "./argon2.js";
import { KdbxInterpreter } from "./kdbxInterpreter.js";
import { uniformCredentials } from "./types.js";

const PASSWORD = "correct horse battery staple";
const vaultId = brand<string, "VaultId">("vault-1") as VaultId;
const rev = (id: string): RevisionId => brand<string, "RevisionId">(id);

function credentials(password: string): kw.Credentials {
  return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password), null);
}

async function createVault(): Promise<Uint8Array> {
  const db = kdbxweb.Kdbx.create(credentials(PASSWORD), "Shared");
  const root = db.getDefaultGroup();
  const entry = db.createEntry(root);
  entry.fields.set("Title", "Bank");
  entry.fields.set("UserName", "vikas");
  entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("original-secret"));
  return new Uint8Array(await db.save());
}

/** Open `bytes`, apply `mutate`, save. Simulates an edit made in KeePassXC. */
async function editVault(
  bytes: Uint8Array,
  mutate: (db: kw.Kdbx) => void
): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes);
  const db = await kdbxweb.Kdbx.load(copy.buffer, credentials(PASSWORD));
  mutate(db);
  return new Uint8Array(await db.save());
}

function addEntry(title: string): (db: kw.Kdbx) => void {
  return (db) => {
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", title);
    entry.fields.set("Password", kdbxweb.ProtectedValue.fromString(`${title}-secret`));
  };
}

async function titlesIn(bytes: Uint8Array): Promise<readonly string[]> {
  const copy = new Uint8Array(bytes);
  const db = await kdbxweb.Kdbx.load(copy.buffer, credentials(PASSWORD));
  const titles: string[] = [];
  const walk = (group: kw.KdbxGroup): void => {
    for (const entry of group.entries) {
      const title = entry.fields.get("Title");
      titles.push(typeof title === "string" ? title : (title?.getText() ?? ""));
    }
    for (const child of group.groups) {
      walk(child);
    }
  };
  for (const root of db.groups) {
    walk(root);
  }
  return titles.sort();
}

describe("Argon2 wiring", () => {
  it("actually routes KDBX4 key derivation through our implementation", async () => {
    let invocations = 0;
    kdbxweb.CryptoEngine.setArgon2Impl(async (...args) => {
      invocations += 1;
      return argon2Impl(...args);
    });

    const db = kdbxweb.Kdbx.create(credentials(PASSWORD), "KdfProbe");
    const kdfUuid = db.header.kdfParameters?.get("$UUID");
    expect(kdfUuid, "KDBX4 default KDF should be Argon2, not AES").toBeDefined();

    const saved = await db.save();
    await kdbxweb.Kdbx.load(saved, credentials(PASSWORD));

    // Save derives a key and load derives it again. If this were AES-KDF the
    // count would stay at zero and every other test here would be proving
    // nothing about hash-wasm.
    expect(invocations).toBeGreaterThanOrEqual(2);

    registerArgon2();
  }, 60_000);
});

describe("KdbxInterpreter", () => {
  const interpreter = new KdbxInterpreter();
  let base: Uint8Array;
  let branchA: Uint8Array;
  let branchB: Uint8Array;

  beforeAll(async () => {
    // Proves the Argon2 implementation is wired: KDBX4 cannot be written at all
    // without it, so reaching this line means hash-wasm produced a usable key.
    registerArgon2();
    base = await createVault();
    branchA = await editVault(base, addEntry("Email"));
    branchB = await editVault(base, addEntry("Router"));
  }, 60_000);

  it("merges entries added independently on two devices", async () => {
    const result = await interpreter.merge({
      vaultId,
      local: { revisionId: rev("a"), bytes: branchA },
      incoming: [{ revisionId: rev("b"), bytes: branchB }],
      credentials: uniformCredentials(PASSWORD, 1)
    });

    expect(result.kind).toBe("merge-succeeded");
    if (result.kind !== "merge-succeeded") {
      return;
    }
    expect(await titlesIn(result.bytes)).toEqual(["Bank", "Email", "Router"]);
    expect(result.parentRevisionIds).toEqual([rev("a"), rev("b")]);
  }, 60_000);

  it("reports a wrong password distinctly from a corrupt file", async () => {
    const result = await interpreter.merge({
      vaultId,
      local: { revisionId: rev("a"), bytes: branchA },
      incoming: [{ revisionId: rev("b"), bytes: branchB }],
      credentials: uniformCredentials("wrong password", 1)
    });

    expect(result.kind).toBe("merge-failed");
    if (result.kind === "merge-failed") {
      expect(result.reason).toMatch(/Wrong password/u);
    }
  }, 60_000);

  it("refuses to merge without credentials rather than guessing", async () => {
    const result = await interpreter.merge({
      vaultId,
      local: { revisionId: rev("a"), bytes: branchA },
      incoming: [{ revisionId: rev("b"), bytes: branchB }]
    });
    expect(result.kind).toBe("needs-credentials");
  });

  it("diffs an added entry", async () => {
    const result = await interpreter.diff({
      vaultId,
      local: { revisionId: rev("base"), bytes: base },
      incoming: [{ revisionId: rev("a"), bytes: branchA }],
      credentials: uniformCredentials(PASSWORD, 1)
    });

    expect(result.kind).toBe("diff-ready");
    if (result.kind !== "diff-ready") {
      return;
    }
    expect(result.diff.addedEntries.map((entry) => entry.title)).toEqual(["Email"]);
    expect(result.diff.removedEntries).toEqual([]);
  }, 60_000);

  it("notices a changed password without revealing it", async () => {
    const changed = await editVault(base, (db) => {
      const entry = db.getDefaultGroup().entries[0];
      entry?.fields.set("Password", kdbxweb.ProtectedValue.fromString("rotated-secret"));
    });

    const result = await interpreter.diff({
      vaultId,
      local: { revisionId: rev("base"), bytes: base },
      incoming: [{ revisionId: rev("changed"), bytes: changed }],
      credentials: uniformCredentials(PASSWORD, 1)
    });

    expect(result.kind).toBe("diff-ready");
    if (result.kind !== "diff-ready") {
      return;
    }
    expect(result.diff.changedEntries).toHaveLength(1);
    expect(result.diff.changedEntries[0]?.changedFields).toContain("Password");

    const serialized = JSON.stringify(result.diff);
    expect(serialized).not.toContain("rotated-secret");
    expect(serialized).not.toContain("original-secret");
  }, 60_000);
});

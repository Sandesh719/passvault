import type * as kw from "kdbxweb";
import type { ChangedEntrySummary, DiffEntrySummary, VaultDiff } from "@passvault/core";
import { kdbxweb } from "./kdbxweb.js";

export interface EntrySnapshot {
  readonly uuid: string;
  readonly title: string;
  readonly groupPath: string;
  readonly fields: ReadonlyMap<string, string>;
  readonly binaryKeys: readonly string[];
}

export interface DatabaseSnapshot {
  readonly entries: ReadonlyMap<string, EntrySnapshot>;
  readonly groups: ReadonlyMap<string, string>;
}

/**
 * Reduce an open database to the minimum needed to describe what changed.
 *
 * Field *values* never leave this module. Protected fields are represented by a
 * digest of their contents, which is enough to notice that a password changed
 * without ever surfacing what it changed to — the earlier prototype substituted
 * a constant placeholder here, which made every password edit invisible to the
 * diff.
 */
export async function snapshotDatabase(db: kw.Kdbx): Promise<DatabaseSnapshot> {
  const entries = new Map<string, EntrySnapshot>();
  const groups = new Map<string, string>();
  for (const root of db.groups) {
    await collectGroup(root, root.name ?? "Root", entries, groups);
  }
  return { entries, groups };
}

async function collectGroup(
  group: kw.KdbxGroup,
  path: string,
  entries: Map<string, EntrySnapshot>,
  groups: Map<string, string>
): Promise<void> {
  groups.set(group.uuid.toString(), path);
  for (const entry of group.entries) {
    const fields = new Map<string, string>();
    for (const [key, value] of entry.fields.entries()) {
      fields.set(key, await fieldFingerprint(value));
    }
    entries.set(entry.uuid.toString(), {
      uuid: entry.uuid.toString(),
      title: entryTitle(entry),
      groupPath: path,
      fields,
      // Attachment names only. Detecting a changed attachment whose name stayed
      // the same would need its content hash, which kdbxweb exposes
      // inconsistently across binary representations.
      binaryKeys: Array.from(entry.binaries.keys()).sort()
    });
  }
  for (const child of group.groups) {
    await collectGroup(child, `${path}/${child.name ?? "Unnamed group"}`, entries, groups);
  }
}

async function fieldFingerprint(value: kw.KdbxEntryField): Promise<string> {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  const binary = value.getBinary();
  try {
    const digest = await kdbxweb.CryptoEngine.sha256(toArrayBuffer(binary));
    return `p:${hex(new Uint8Array(digest)).slice(0, 32)}`;
  } finally {
    binary.fill(0);
  }
}

function entryTitle(entry: kw.KdbxEntry): string {
  const title = entry.fields.get("Title");
  if (title === undefined) {
    return "Untitled";
  }
  return typeof title === "string" ? title || "Untitled" : title.getText() || "Untitled";
}

export function diffSnapshots(base: DatabaseSnapshot, incoming: DatabaseSnapshot): VaultDiff {
  const addedEntries: DiffEntrySummary[] = [];
  const removedEntries: DiffEntrySummary[] = [];
  const changedEntries: ChangedEntrySummary[] = [];
  const addedGroups: string[] = [];
  const removedGroups: string[] = [];
  const changedGroups: string[] = [];

  for (const [uuid, entry] of incoming.entries) {
    const baseEntry = base.entries.get(uuid);
    if (baseEntry === undefined) {
      addedEntries.push(summarize(entry));
      continue;
    }
    const changedFields = changedEntryFields(baseEntry, entry);
    if (changedFields.length > 0) {
      changedEntries.push({ ...summarize(entry), changedFields });
    }
  }
  for (const [uuid, entry] of base.entries) {
    if (!incoming.entries.has(uuid)) {
      removedEntries.push(summarize(entry));
    }
  }
  for (const [uuid, path] of incoming.groups) {
    const basePath = base.groups.get(uuid);
    if (basePath === undefined) {
      addedGroups.push(path);
    } else if (basePath !== path) {
      changedGroups.push(path);
    }
  }
  for (const [uuid, path] of base.groups) {
    if (!incoming.groups.has(uuid)) {
      removedGroups.push(path);
    }
  }

  return { addedEntries, removedEntries, changedEntries, addedGroups, removedGroups, changedGroups };
}

function changedEntryFields(base: EntrySnapshot, incoming: EntrySnapshot): readonly string[] {
  const changed = new Set<string>();
  for (const [key, value] of incoming.fields) {
    if (base.fields.get(key) !== value) {
      changed.add(key);
    }
  }
  for (const key of base.fields.keys()) {
    if (!incoming.fields.has(key)) {
      changed.add(key);
    }
  }
  if (base.groupPath !== incoming.groupPath) {
    changed.add("Group");
  }
  if (base.binaryKeys.join("\0") !== incoming.binaryKeys.join("\0")) {
    changed.add("Attachments");
  }
  return Array.from(changed).sort();
}

function summarize(entry: EntrySnapshot): DiffEntrySummary {
  return { uuid: entry.uuid, title: entry.title, groupPath: entry.groupPath };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes);
  return copy.buffer;
}

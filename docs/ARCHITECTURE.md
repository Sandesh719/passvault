# Architecture

## What this project actually is

PassVault is **not** a password manager. KeePassXC is the password manager: it
owns encryption, password generation, and the UI you type passwords into.

PassVault is the layer that keeps two copies of the same `.kdbx` file in step
across devices, without a cloud service in the middle. It watches the file
KeePassXC saves, keeps a history of every version, moves those versions directly
between your devices over an encrypted peer-to-peer connection, and works out
what to do when both devices changed at once.

Everything else in this document follows from one design decision, so it comes
first.

---

## The decision everything hangs on: the ciphertext boundary

A `.kdbx` file is already encrypted by KeePassXC. PassVault treats those bytes as
**opaque** — it moves them, stores them, and compares them, but almost never
opens them.

That sounds like a limitation. It is actually what makes the rest of the system
simple, and it works because of a second idea:

> **Whether two devices have diverged is a property of the shape of their
> history, not of the vault's contents.**

If device A's version descends from device B's version, A is simply ahead — no
decryption needed to know that. Only when the two genuinely *forked* and you
choose to combine them does anything need the master password.

So exactly one package — `packages/kdbx` — can decrypt. It is handed raw bytes,
returns raw bytes, and **imports nothing from `node:fs`**, so decrypted material
has no route to disk even by accident.

This is not a convention people are asked to remember. `tests/architecture.test.ts`
scans every source file and fails the build if:

- anything outside `packages/kdbx` imports `kdbxweb` (the decryption library),
- anything inside `packages/kdbx` imports a filesystem or storage module,
- the Electron renderer imports Node, storage, identity, or sync modules,
- `packages/sync` imports anything platform-specific.

A boundary that isn't enforced erodes; these four tests are the enforcement.

---

## Vocabulary

You need five terms before the rest makes sense.

| Term | Meaning in this codebase |
| --- | --- |
| **Revision** | One immutable snapshot of the vault's encrypted bytes, plus who made it, when, and which revision(s) it came from. Never modified after creation. |
| **Revision DAG** | The graph formed by revisions pointing at their parents. "DAG" = directed acyclic graph — like git's commit graph. Branching is normal; cycles are impossible. |
| **Head** | The one revision currently considered "in use" on this device, and therefore written out to the `.kdbx` file. |
| **Blob** | The actual encrypted bytes of a revision, stored on disk under a filename derived from their SHA-256 hash. |
| **Peer / device** | Another installation of PassVault you have paired with, identified by a long-lived Ed25519 public key. |

---

## The shape of the system

```
┌──────────────────────────── one device ────────────────────────────┐
│                                                                    │
│  Electron main process            │  Electron renderer process     │
│  ─────────────────────            │  ─────────────────────────     │
│  storage, DAG, device private key │  React UI + WebRTC             │
│                                   │                                │
│  DesktopServices ──── IPC ────────┼──► PeerBridge ──► RTCDataChannel
│    SyncEngine                     │       │                        │
│    SyncSession                    │       └──► WebSocket ──► signaling
│    SQLite + blob store            │                          server │
│    KeePassXC file watcher         │                                 │
└────────────────────────────────────────────────────────────────────┘
                                                    │
                                     encrypted P2P  ▼
                                              other device
```

### The packages, and what each is responsible for

Dependencies point **inwards**: `core` knows nothing about the others; the apps
know about everything.

**`packages/core` — the rules, with no I/O whatsoever.**
Pure functions and interfaces. The DAG algorithms (`dag.ts`), the wire protocol
and its validating parser (`protocol.ts`), binary chunk framing (`framing.ts`),
revision constructors (`lineage.ts`), pairing-code formats (`shortCode.ts`), and
crucially the **ports** (`ports.ts`) — TypeScript interfaces describing what the
outside world must provide: `BlobStore`, `MetadataStore`, `PeerLink`,
`PeerAuthenticator`, `HashPort`.

A *port* is just an interface that inverts a dependency: the engine says "give me
something that can store bytes by hash", and never learns whether that turns out
to be a filesystem, a mobile content provider, or an in-memory map used by a test.

**`packages/sync` — the engine and the session, platform-free.**
Two distinct things:

- `SyncEngine` (`engine.ts`) — all the *stateful decisions* about revisions:
  import a vault, record a local change, ingest a revision from a peer, merge,
  promote, fast-forward. It talks only to ports.
- `SyncSession` (`session.ts`) — one conversation with one peer, from handshake
  to completion. It is a **state machine over a `PeerLink`**, also only ports.

Because neither imports Node, React, or WebRTC, the entire sync protocol can run
headlessly in tests over an in-memory pipe (`packages/transport/memoryLink.ts`) —
no network, no browser, no signaling server. That is why the test suite can cover
the protocol so thoroughly.

**`packages/identity` — who a device is, and who it trusts.**
Ed25519 keypairs, the rule that a device's id *is* the SHA-256 of its public key,
the trust store of pinned peer keys, the pairing-offer format, and the six-digit
Short Authentication String.

**`packages/kdbx` — the decryption boundary.** The only place a vault is opened,
merged, or diffed. See above.

**`packages/storage-node` — the Node-flavoured adapters.**
Concrete implementations of the ports: `FileBlobStore` (content-addressed files),
`SqliteMetadataStore` (the DAG and trust tables), and `VaultFileWatcher` /
`writeVaultFileAtomic` — the bit that cooperates with KeePassXC on disk.

**`packages/transport` — WebRTC plumbing and its test double.**
`webrtcLink.ts` wraps `RTCDataChannel` as a `Channel`; `memoryLink.ts` implements
the same interface with two queues, which is what lets sessions run in tests.

**`apps/desktop` — the Electron app.** Orchestration (`main/services.ts`), the
preload bridge, and the React UI.

**`apps/signaling` — a small stateless server.** Rooms, short pairing codes,
rate limiting. Holds no vault data, ever.

**`apps/demo`** — a headless end-to-end script (`pnpm demo`) that drives two
engines through a real KDBX file: import, sync, diverge, merge, write back.

---

## Design decisions worth understanding

### 1. Immutable revisions in a DAG, rather than "latest file wins"

A single "current version" field cannot tell you whether the incoming file
*contains* your changes or *replaces* them. A parent graph can, and the answer
comes from `classifyDivergence` in `core/src/dag.ts`, which returns exactly one
of five verdicts:

| Verdict | Meaning | What happens |
| --- | --- | --- |
| `equal` | Same head | Nothing |
| `local-ahead` | Their head is our ancestor | We send |
| `remote-ahead` | Our head is their ancestor | Fast-forward (safe: nothing is lost) |
| `diverged` | Genuine fork | Raise a conflict; ask the user |
| `unrelated` | No shared history at all | Almost certainly two different vaults |

`unrelated` exists because of a real failure mode: if you *import* the same file
separately on both devices, each mints its own vault id and the two can never
reconcile. A vault must be shared from one device and **joined** on the other.
The session refuses this case with a plain-English message rather than trying to
paper over it.

The cost of this design is honest: history grows forever, and there is currently
no garbage collection.

### 2. Content-addressed blobs, and "blob first, metadata second"

Revision bytes live at `blobs/<first-two-hex>/<sha256>.kdbx`. Because the
filename *is* the hash:

- integrity checking needs no extra bookkeeping — bytes that don't hash to their
  own filename are detectably corrupt;
- two devices holding identical bytes converge on one entry for free;
- a revision row can never disagree with the file it names, because there is no
  path stored anywhere to get out of sync.

Every write follows one ordering rule, stated in `engine.ts`: **write the blob
before the metadata row.** An orphaned blob is harmless garbage; a metadata row
pointing at bytes that were never written is a corrupted history.

### 3. A symmetric protocol — no client, no server

Both devices run the *same* `SyncSession` code. Each phase is a rendezvous: send
ours, await theirs. This means either device can start a sync, neither can starve
the other by choosing an ordering, and there is only one code path to reason
about instead of two that must agree.

### 4. Two data channels, not one

`passvault/control` carries JSON messages; `passvault/bulk` carries raw vault
bytes. A multi-megabyte transfer would otherwise sit in front of the
acknowledgements and cancellations that manage it.

### 5. The signaling server is deliberately almost useless

It does two things: hand out rooms so two peers can exchange WebRTC connection
details, and hold short pairing codes for ten minutes. It has **no database, no
volume, no kdbx dependency**, and forgets everything on restart.

This is a security decision, not a simplicity one. The server never sees vault
bytes, and it *cannot* impersonate a device — see the Short Authentication String
below. The trade-off: two devices must be pointed at a server both can reach
(configurable per device, defaulting to `passvault-sandy.duckdns.org`), and if
the network blocks direct connections a TURN relay is needed.

### 6. Trust is pinned keys plus a human comparison

WebRTC gives you an encrypted pipe (DTLS) but says **nothing about who is on the
other end** — anyone who learns the room details can connect. So:

- A device's id is the hash of its public key, so an id and a key can never
  disagree.
- During the handshake each side signs a nonce the *other* side generated, which
  proves live possession of the private key and cannot be replayed from a
  recording.
- On first pairing, both devices display a **six-digit Short Authentication
  String** derived from *both* public keys. A malicious server that substituted
  its own keys would cause the two devices to compute *different* numbers.
- The handshake genuinely **pauses** on that number (`confirmPairing` in
  `identity/src/authenticator.ts`). Nothing is pinned and no vault data moves
  until a person answers, so declining leaves no trace to undo.

`pairingMode` — the permission to pin a never-before-seen key — is on only while
someone is actively pairing, and expires after five minutes.

### 7. The Electron process split is a security boundary

The renderer runs the UI and WebRTC — because Chromium's WebRTC stack lives
there, and the main process should not be running a browser engine to get it.

The renderer has **no filesystem, no database handle, and no access to the device
private key**. Everything it may do is enumerated one method at a time in
`preload/index.ts`. Nothing there forwards an arbitrary channel name or path.

This creates an interesting problem: the session runs in the main process but the
data channels live in the renderer. `main/ipcPeerLink.ts` solves it by
implementing the *same* `PeerLink` port over IPC — the interface designed for
in-memory tests turns out to bridge a process boundary just as well. Backpressure
survives the crossing, because the renderer reports the real
`RTCDataChannel.bufferedAmount` back to the main process.

### 8. Ports exist so the engine can move to Android later

`packages/sync` depending only on `packages/core` interfaces is what makes M4
(Android via Capacitor) a matter of writing new adapters rather than rewriting
the engine. The architecture test keeps that promise honest today.

---

## Known limits (from the code, not aspiration)

- **One vault at a time**, and only the most recently paired device is
  auto-reconnected at startup (`standingRendezvous` uses `LIMIT 1`).
- **Transfers do not resume** across a reconnect. The `chunk_bitmap` column
  exists in the schema but nothing writes it.
- Several `MetadataStore` methods are implemented and tested but **never called
  by the app today**: `saveTransfer`, `saveBookmark`, `appendEvent`/`listEvents`,
  and `getPeerHead`. In particular, `recordPeerHead` *is* written on every
  session but never read back, so the "skip redundant history exchange"
  optimisation its comment describes is not yet implemented.
- **TURN relay is configurable but untested** against a real deployment.
- No QR-code pairing yet, which is what a phone will actually want.

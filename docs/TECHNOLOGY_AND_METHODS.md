# Technologies and Methods

What each major piece is, where it's used, why it was chosen, and what it costs.
Obvious dependencies (TypeScript, React, pnpm workspaces) are skipped except
where a *specific* choice about them matters.

---

## A theme worth noticing first

Four separate cryptographic and storage needs — Ed25519 signatures, Argon2 key
derivation, SHA-256, and SQLite — could each have used a fast native binding.
All four instead use **pure JavaScript or WebAssembly**.

That is one decision applied consistently, and the reasoning is the same every
time: the same code must run on Node (tests), Electron (desktop), and eventually
an Android WebView. A native binding means a per-platform build step, and in
Electron's case a genuinely unwinnable one — see SQLite below.

---

## Peer-to-peer transport

### WebRTC data channels

**What it is.** A browser API for direct peer-to-peer connections. Usually
associated with video calls, but `RTCDataChannel` carries arbitrary data, is
encrypted end-to-end with DTLS, and can traverse NAT.

**Where.** `packages/transport/webrtcLink.ts` and
`apps/desktop/src/renderer/peerBridge.ts`.

**Why.** It is the only widely available way to get an encrypted, NAT-traversing,
direct connection between two consumer machines without running a server that
handles the data.

**Trade-offs.** Its API is large and event-driven, so it is wrapped behind the
narrow `Channel` port. Two channels are opened rather than one, so bulk transfers
don't block control messages. Critically, **DTLS proves the pipe is encrypted but
says nothing about who is on it** — anyone who learns the room details can
connect. Device authentication is therefore layered on top; WebRTC alone would be
no security at all.

### STUN and TURN

**What they are.** STUN tells a machine what its public address looks like from
outside, which usually lets two peers find a direct path. TURN is a relay for
when they can't — it forwards the encrypted traffic without being able to read it.

**Where.** `main/settings.ts` builds the ICE server list. STUN defaults to
Google's public server; TURN is user-configured.

**Trade-off.** Some networks — mobile carriers, restrictive corporate firewalls,
symmetric NAT — block direct connections entirely, and **without a relay those
devices simply never connect**. The relay is configured but, as the README states,
untested against a real coturn deployment.

### WebSocket signaling (`ws`)

**What it is.** A persistent bidirectional connection, used here to exchange
WebRTC setup messages (SDP offers/answers, ICE candidates) before the direct
connection exists.

**Where.** `apps/signaling/src/index.ts` (server), `peerBridge.ts` (client).

**Why not HTTP polling.** ICE candidates arrive asynchronously and must be
relayed promptly; a push channel is the natural fit.

**Hardening applied.** `ws` allows 100 MB frames by default, which is an
invitation to fill the process — capped to 256 KB. A 30-second ping/pong
heartbeat terminates sockets whose network vanished, since otherwise the OS never
closes them and the rooms they hold never empty.

---

## Storage

### SQLite via `node-sqlite3-wasm`

**What it is.** SQLite is an embedded database — a library reading one local
file, not a server. This is a **WebAssembly** build of it.

**Where.** `packages/storage-node/sqliteDriver.ts`; schema in `schema.ts`.

**Why SQLite at all.** Two things a flat file can't give you: real transactions
(a sync interleaves revision writes with head moves, and a crash between them
would leave a DAG referencing revisions it doesn't have), and recursive ancestry
queries. It is used for *correctness*, not scale.

**Why WASM specifically.** This is the clearest example of the theme above.
`better-sqlite3` compiles against a specific Node ABI, and Electron ships its own.
Making it work in the desktop app means rebuilding it for Electron — which then
breaks it for plain `node`, and the test suite with it. With pnpm hard-linking
one copy across the workspace, there is no arrangement that leaves both working.

**The cost, stated plainly in the source:** the WASM VFS doesn't support WAL, so
the database runs in rollback-journal mode. Writes are still atomic and crash-safe
(SQLite's classic default), but readers and writers don't overlap. For a
single-process desktop agent, nothing notices.

### Content-addressed blob storage

**What it is.** Store bytes under a filename derived from their own hash. Git
does the same thing.

**Where.** `packages/storage-node/blobStore.ts`.

**Advantages here.** Integrity is structural rather than bookkept; identical
content deduplicates automatically; a revision row can never disagree with the
file it names. Files are sharded one level by the first two hex characters —
a flat directory is fine at personal scale but degrades on some filesystems past
tens of thousands of entries, and sharding is free.

### Atomic write via temp-file-and-rename

**What it is.** Write to a temp file, `fsync` it, then `rename()` over the target.
POSIX makes rename atomic *within a filesystem*, so a reader sees either the whole
old file or the whole new one.

**Where.** `blobStore.put` and `writeVaultFileAtomic`.

**The detail that matters.** The temp file must be in the **same directory** as
the target, not `/tmp`, which is often a different filesystem where the atomicity
guarantee evaporates.

### chokidar (file watching)

**What it is.** A cross-platform file-watching library that smooths over the
differences between macOS, Linux, and Windows watch APIs.

**Where.** `VaultFileWatcher`.

**Why not `fs.watch`.** Platform behaviour differs sharply, and KeePassXC saves
by rename — which surfaces as unlink-then-add rather than a change event.
chokidar's `awaitWriteFinish` plus a 400 ms debounce plus a retry-once read is
what turns a messy burst of events into one settled snapshot.

---

## Cryptography and trust

### Ed25519 via `@noble/curves`

**What it is.** A modern elliptic-curve signature scheme — small keys (32 bytes),
fast, no parameter choices to get wrong. `@noble/curves` is a pure-JavaScript,
audited implementation.

**Where.** `packages/identity/identity.ts`.

**Why not WebCrypto.** WebCrypto only gained Ed25519 in recent Chrome versions,
which would mean a platform branch in the one place a branch is least welcome.

**How it's used.** The device id *is* `sha256(publicKey)`, so an id and a key can
never disagree — removing a whole class of impersonation. During a handshake each
side signs a challenge string containing the **peer's** nonce plus both device
ids; signing their nonce rather than your own is what makes it a proof of liveness
instead of a replayable token.

### Short Authentication String (SAS)

**What it is.** A method from secure-voice protocols (ZRTP, and Signal's safety
numbers): both parties derive a short human-comparable number from *both* public
keys, and a person confirms the two screens match.

**Where.** `shortAuthenticationString` in `identity.ts`; the pause is
`confirmPairing` in `authenticator.ts`.

**Why it works.** A signaling server sitting in the middle would have to
substitute its own keys — and then each side hashes a *different* pair, so the two
numbers differ and the humans notice. The keys are sorted before hashing so both
sides compute the same value regardless of who asks.

**Why six digits is enough.** An attacker gets exactly one shot at a live
comparison, not offline guesses. The number is short enough to read aloud, which
is the actual requirement.

**Its limitation:** it is only as strong as the person actually comparing. That is
why the handshake *blocks* on it rather than displaying it decoratively after
pairing has already happened.

### Argon2 via `hash-wasm`

**What it is.** A memory-hard key-derivation function — deliberately expensive in
RAM as well as CPU, so brute-forcing a master password can't be cheaply
parallelised on GPUs. KDBX4 requires it.

**Where.** `packages/kdbx/argon2.ts`, registered into kdbxweb's crypto engine.

**Why hash-wasm.** kdbxweb doesn't ship an Argon2 implementation; you must supply
one. Same reasoning as everywhere else: one WebAssembly module, every runtime, no
node-gyp.

### Electron `safeStorage` (OS keychain)

**Where.** `main/identityStore.ts`.

**Why.** The device private key on disk in plaintext means another machine can
impersonate this device. `safeStorage` encrypts it with the OS keychain.

**Honest fallback.** Where no keychain is available it writes the key in
plaintext with `0600` permissions **and tells the user in the activity log**,
rather than pretending the protection exists.

---

## Vault format

### kdbxweb

**What it is.** A pure-JavaScript KDBX (KeePass database) reader/writer,
including KDBX's own **entry-level merge** with conflict resolution based on
per-entry modification times and UUIDs.

**Where.** `packages/kdbx` only — enforced by an architecture test.

**Why it matters.** Merging password databases correctly is genuinely hard, and
KDBX already defines the semantics. `localDb.merge(incomingDb)` reuses that rather
than inventing a scheme KeePassXC wouldn't agree with.

**Two real gotchas the code documents.** kdbxweb is CommonJS, so under Node's ESM
loader `import * as kdbxweb` yields an object of `undefined`s while a *default*
import works — and bundlers paper over the difference, so the mistake typechecks,
passes Vite-run tests, and fails only in the packaged app. Hence a single import
site (`kdbxweb.ts`). Second, it reports a wrong password as a typed error, which
is surfaced distinctly because "wrong password" and "corrupt file" lead a user to
completely different actions.

---

## Application shell

### Electron

**What it is.** Chromium plus Node in one desktop app, split into a **main**
process (Node, full system access) and a **renderer** process (the web page).

**Why.** WebRTC needs Chromium's implementation; the file watching, SQLite, and
key handling need Node.

**How the split is used.** As a security boundary, not just an implementation
detail — the renderer gets no filesystem, no database, and no private key, and
reaches the main process only through the enumerated `contextBridge` methods in
`preload/index.ts`. `contextIsolation: true` and `nodeIntegration: false` are what
make that boundary real rather than nominal.

**Trade-offs.** Large installers, and the session/data-channel split across
processes needs the IPC `PeerLink` adapter to bridge it. Builds are currently
**ad-hoc signed only** (`identity: "-"`), so both macOS and Windows warn about an
unidentified developer.

### Tailwind CSS v4

**Where.** `renderer/styles.css` defines design tokens in an `@theme` block;
`renderer/ui.tsx` holds the reusable shapes.

**The rule the codebase follows.** Reuse happens through **React components, not
CSS classes**. A `.card` class alongside a `<Card>` component inevitably drifts,
and then it's unclear which owns a given rule.

**A real gotcha, hit twice during development.** Tailwind has no cascade priority
between two utilities targeting the same property — `text-ink` over `text-muted`
is resolved by *stylesheet output order*, not by which you wrote last. The fix is
to not layer conflicting utilities; the nav buttons in `main.tsx` are spelled out
rather than built from `<Button tone="ghost">` for exactly this reason.

---

## Algorithms and protocol methods

### DAG ancestry and merge base

**What it is.** Standard version-control graph theory. `isAncestor` answers
"does theirs contain ours?"; `findMergeBase` finds the best common ancestor —
common ancestors that are not themselves an ancestor of another common ancestor.

**Where.** `packages/core/dag.ts`.

**Implementation choices that matter.**
- The whole graph is loaded into memory as `{id, parentIds}` pairs. That is tiny
  even for tens of thousands of revisions, and keeps the algorithms pure and
  synchronous rather than pushing traversal into SQL.
- Traversals are **iterative, not recursive** — they walk peer-supplied data, and
  a deep or hostile history must not overflow the stack.
- A parent that isn't in the graph is treated as a frontier and skipped, not an
  error: a peer's history summary is legitimately partial, and a missing parent is
  information ("I need that one").
- `topologicalOrder` throws on a cycle, because peer-supplied history containing
  one is either corruption or an attack, and must not be persisted either way.

### A validating protocol parser

**Where.** `packages/core/protocol.ts`.

**What it does.** Every inbound control message is parsed field by field against
explicit caps: at most 100,000 history nodes, 64 parents per revision, 512 MB per
revision, 4096-character strings.

**Why.** Every one of those fields arrives from the other end of a data channel.
Without bounds, a single well-formed message could ask you to build a
ten-million-node graph or buffer a gigabyte — *before* you have decided whether
you trust the sender. The tests drive this parser with hostile input specifically.

### Binary chunk framing with backpressure

**What.** An 8-byte header (`transferSeq`, `chunkIndex`) plus payload, 64 KiB per
chunk.

**Why binary.** An earlier prototype sent chunks as base64 inside JSON: 33% more
wire bytes than the payload itself, plus a string round-trip on both ends. Data
channels carry binary natively.

**Why 64 KiB.** Comfortably under the 256 KiB message ceiling that SCTP
implementations agree on.

**Backpressure** is not optional here: without awaiting `bufferedamountlow`
between chunks, a large vault is pushed in faster than SCTP drains it and the
connection is torn down. The prototype had none.

### Token-bucket rate limiting

**Where.** `apps/signaling/rateLimit.ts`, on `/rooms` and `/pairing-codes`.

**Why.** Eight-character pairing codes could otherwise be guessed at line speed
rather than one attempt at a time. Two separate buckets, because creating a room
reserves memory until it expires while redeeming a code is just a lookup.

**One subtlety worth internalising.** The client key is read from the **last**
`X-Forwarded-For` hop, not the first. Proxies *append* the real address, so
trusting the first hop lets a client supply its own value and pick its own
bucket — which is the same as having no rate limit. Caddy is additionally
configured to *overwrite* the header rather than append.

### Architectural fitness tests

**Where.** `tests/architecture.test.ts`.

**What it is.** Tests that assert facts about the *structure* of the code — which
modules may import which — rather than about behaviour.

**Why.** The security claims ("only kdbx decrypts", "the renderer can't reach the
private key") are only true while they stay true. This makes violating one fail
the build instead of quietly eroding. Type-only imports are excluded, since
borrowing a type is not the same as gaining a capability.

---

## Deployment

### Docker Compose + Caddy

**Where.** `deploy/`.

**Why Caddy.** It obtains and renews TLS certificates automatically. That's a
requirement, not a nicety: the app **refuses plaintext** to any host that isn't
loopback or `.local`, because a pairing offer altered in flight points a device
somewhere else entirely.

**How the server is locked down.** Read-only filesystem, all capabilities
dropped, `no-new-privileges`, a 256 MB memory ceiling, and the signaling port
`expose`d rather than published — the only way in is through the proxy. Caddy's
access log deletes the request URI, because pairing codes appear in the path and
logging them would write a working credential to disk.

**Why it's this simple.** The server is one stateless process with no database
and no volume. It introduces two peers and forgets them, which is what makes it
safe to restart at any moment.

### GitHub Actions matrix build

**Where.** `.github/workflows/release.yml`.

**The point worth taking.** Each installer is built on the OS it targets. A
Windows installer *can* be produced from macOS through wine, but the result is
unverifiable on the machine that made it — nothing there can run it. A Windows
runner builds it *and launch-tests it*, checking the app both starts and creates
its database. That is the difference between shipping an installer and hoping.

---

## The verification ladder

Four checks, cheapest first — worth knowing because it tells you where to look
when something breaks.

| Command | Covers | Doesn't cover |
| --- | --- | --- |
| `pnpm demo` | The whole stack headlessly against real KDBX files: pair, sync, diverge, merge, write back | Networking, UI |
| `pnpm test` | ~224 tests: ancestry, hostile protocol input, framing, backpressure, auth, storage durability, architectural boundaries | Real WebRTC |
| `pnpm two` | Two real app instances on one machine (separate profiles, keys, databases) over loopback WebRTC | Real NAT, TLS, packaging |
| CI matrix | Packaged installers, launched on a real Windows runner | Real-world NAT traversal, TURN |

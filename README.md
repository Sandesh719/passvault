# PassVault

A local-first synchronization layer for KeePass-compatible `.kdbx` vaults.

KeePassXC (desktop) and KeePassDX / Keepass2Android (mobile) remain the password
manager: they own encryption, password generation, and the user interface. This
project owns everything between two copies of the same vault — local persistence,
an immutable revision history, device pairing, peer-to-peer transport, divergence
detection, merging, and conflict resolution.

The signaling server only helps two peers negotiate a WebRTC connection. It never
receives vault contents or credentials. When a direct connection is impossible a
TURN relay can carry the encrypted traffic, without becoming a place vaults are
stored.

## Design constraint

Everything except one package operates on **ciphertext**. The revision DAG,
transport, persistence, and conflict *detection* never need the master password —
divergence is a property of the graph's shape, not the vault's contents.

Only conflict *resolution by merging* requires decryption, and that lives solely
in `packages/kdbx`, which is handed bytes and has no filesystem access. Both rules
are enforced by tests in `tests/architecture.test.ts` rather than by convention.

## Layout

| Package | Responsibility |
| --- | --- |
| `packages/core` | Domain logic: revision DAG, ancestry, lineage rules, conflict FSM, protocol, ports. No I/O. |
| `packages/kdbx` | The decryption boundary. KDBX merge and diff via kdbxweb. |
| `packages/identity` | Ed25519 device keys, pairing codes, trust store, short authentication strings. |
| `packages/sync` | The sync engine and session state machine. No platform dependencies. |
| `packages/transport` | WebRTC links, signaling client, and an in-memory link pair for tests. |
| `packages/storage-node` | Blob store, SQLite metadata, and the KeePassXC file watcher. |
| `apps/desktop` | Electron app. Main process owns storage and the engine; the renderer owns WebRTC. |
| `apps/signaling` | Connection-brokering server. Holds no vault data. |

## Security model

- The `.kdbx` file stays encrypted by KeePassXC. The sync layer moves ciphertext.
- The signaling server relays connection setup only. It has no kdbx dependency
  and never receives vault bytes or credentials.
- Devices authenticate each other with Ed25519 keys pinned at pairing time.
  Nothing about the vault — not even its id — is exchanged before both sides
  prove possession of a pinned key.
- Pairing shows a six-digit code derived from both public keys. A machine in the
  middle cannot make the two devices display the same number. The handshake
  pauses on that number: nothing is pinned and no vault data moves until a
  person confirms it, so refusing costs nothing to undo.
- Short pairing codes are held by the signaling server for ten minutes and are
  single-use. They stand in for the pairing link, which is public by design —
  it grants the ability to attempt a connection, not authority.
- Any server that is not loopback or a `.local` name is reached over TLS, and
  the app will not fall back to plaintext. An offer altered in flight is an
  offer that points somewhere else.
- The device private key lives outside the metadata database, encrypted with the
  OS keychain, with owner-only file permissions.
- Decryption happens only when a merge needs it, and only inside `packages/kdbx`,
  which has no filesystem access.

## Storage

No database server. SQLite is an embedded library reading one local file; it is
used for transactions and ancestry queries, not for scale.

```
<appdata>/blobs/<aa>/<sha256>.kdbx   encrypted revision bytes, content-addressed
<appdata>/tmp/                       in-flight writes, swept at startup
<appdata>/metadata.db                revision DAG, device trust, transfer state
```

Blobs are written before metadata, always. An orphaned blob is harmless and
collectable; a metadata row pointing at bytes that were never written is a
corrupted history.

## Development

Requires Node 22 (see `.node-version`) and pnpm.

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm test
```

## Is it working?

Three checks, cheapest first.

**1. The whole system, headless.** Creates a real KDBX vault, runs two devices
through pairing, sync, offline divergence, merge, promote, and write-back via
the real file watcher, then verifies the resulting file:

```bash
pnpm demo
```

**2. The test suite.** 221 tests covering ancestry, the protocol parser against
hostile input, framing, backpressure, authentication, storage durability, and
the architectural boundaries:

```bash
pnpm test
```

**3. Real WebRTC between two desktop apps.** The only path the first two do not
cover — see below.

## Trying it

You do not need two computers. Two app instances on one machine *are* two
devices: each gets its own profile directory, and therefore its own keypair, its
own database, and its own vault file. They are as separate as two laptops, and
the only thing they share is the loopback network they talk over.

```bash
pnpm two
```

That starts the signaling server, creates two sample vaults, and opens two
labelled windows side by side. Then:

1. On **Laptop** only: Home → *My password file is on this device* → pick
   `.sandbox/Laptop.kdbx`. Leave Desktop alone; a vault is shared from one device
   and joined on the other.
2. **Laptop** → Devices → *Get a code*. Eight characters, e.g. `4F7K-2QX9`
3. **Desktop** → Devices → type it → *Connect*
4. Both windows stop and show the same six digits. Answer *Yes, they match* on
   each — this is the security step, and the handshake genuinely waits for it
5. Desktop receives the vault and offers to save it locally

After that it looks after itself: a save in KeePassXC is picked up, sent to the
other device, and written to its file automatically. `Sync now` on the Devices
tab is there for when a device has been offline.

`pnpm two --fresh` wipes both profiles and starts over. Ctrl-C stops everything.

To run a single instance against your own vault and signaling server:

```bash
pnpm signaling
```

```bash
pnpm desktop
```

## Two devices in different places

Everything above works over loopback without configuration. Across the internet
there are two things to get right.

**A server both devices can reach.** The signaling server is one process with no
database and no state worth backing up — it introduces peers and forgets them.
Run it with `deploy/docker-compose.yml`, which brings up the server behind a
proxy that gets a TLS certificate on its own, then set that address in each
device under **Devices → Connection server**. See [DEPLOY.md](DEPLOY.md). The app checks the address
answers, and that it is a PassVault server, before you rely on it.

Each device keeps its own setting, so the two do not have to agree in advance —
but a pairing code is only held by the server that issued it. That is why a code
can carry its own address:

```
4F7K-2QX9                       redeemed on this device's server
4F7K-2QX9@sync.example.org      redeemed there, whatever this device is set to
```

The pairing panel shows both. The plain code is enough when both devices use the
same server; the longer one always works.

**A path between the two devices.** Most pairs find one directly, with STUN. Some
networks — mobile carriers, restrictive office firewalls — block that, and those
need a TURN relay, which is the optional part of the same settings panel. The
relay carries WebRTC traffic it cannot read, keeps no copy, and holds nothing
once the session ends. Without one, devices on such a network will not connect
at all.

Nothing in either case changes what the server sees: the vault is encrypted by
KeePassXC before this application touches it.

## Status

**M1 (foundation)** — durable persistence, the ancestry layer, the consolidated
merge path, and a platform-free sync engine.

**M2 (sync protocol)** — versioned session protocol with a validating parser,
binary chunk framing, data-channel backpressure, and a symmetric session state
machine. Two engines complete a full sync over an in-memory link, with no WebRTC
stack and no network.

**M3 (desktop)** — Ed25519 device identity and pairing with short authentication
strings, mutual authentication in the handshake, KeePassXC file watching and
atomic write-back that respects its lock file, and an Electron app that keeps
storage and the private key out of the renderer.

Next: Android (M4) — the same engine behind a Capacitor shell, a storage adapter
over the Storage Access Framework so KeePassDX can open the synced file, and
TURN fallback for mobile networks.

### Known gaps

- Only one vault at a time, and only one paired device is auto-reconnected.
- No QR codes yet, which is what a phone will actually want.
- The relay is configured but untested against a real TURN deployment.
- Transfers do not resume across a reconnect. The chunk bitmap column exists.
- No TURN relay, so a network that blocks direct connections has no fallback.

# Deploying PassVault

Two independent things ship: a **signaling server**, which two devices use to
find each other, and the **desktop app**, which people install.

The server holds no vaults and no passwords. It keeps a map of who is currently
trying to reach whom, in memory, and forgets it on restart. Nothing on it needs
backing up, and losing it costs an in-progress pairing and nothing else.

---

## 1. The signaling server

### What you need

- A machine with a public address and Docker.
- A hostname pointing at it, with DNS already resolving — the certificate
  cannot be issued before that.
- Ports 80 and 443 open. 80 is only used to prove the domain and redirect.

### Doing it without paying, ever

Most of the easy platforms are free only for a while: Fly.io and Railway both
start billing once the trial credit runs out. Two things genuinely stay free.

**The machine.** An always-free VM:

| | |
| --- | --- |
| Oracle Cloud Always Free | An AMD micro instance is ample here. Card required for identity, not billed. ARM instances are free too but frequently out of capacity. |
| Google Cloud free tier | An `e2-micro` in `us-west1`, `us-central1` or `us-east1`. Card required. Egress allowance is small, which suits a server that moves no vault data. |

Neither expires. Both want a card on file to prove you are a person.

**The hostname.** [DuckDNS](https://duckdns.org) gives you
`something.duckdns.org` free and permanently, pointed at any address you like.
Caddy gets a certificate for it exactly as it would for a domain you bought, so
nothing in this setup changes — put it in `PASSVAULT_DOMAIN` and continue.

Two things that catch people on Oracle specifically: open 80 and 443 in the
VCN security list *and* in the instance firewall (their images ship with
restrictive `iptables`, so the cloud-side rule alone is not enough).

Avoid free tiers that sleep when idle. A device sitting in its rendezvous
waiting for the other one to come online is the normal state of this server, and
a platform that suspends after fifteen minutes turns every reconnect into a
cold start.

### Step by step, free, on Oracle Cloud + DuckDNS

**1. Get a free name.** Sign in at [duckdns.org](https://duckdns.org) with any
account, invent a subdomain, and copy the token from the top of the page. You
now own `something.duckdns.org` for as long as you want it.

**2. Make the VM.** In Oracle Cloud, create an Always Free instance — an AMD
micro is plenty, Ubuntu is the easiest image. Save the SSH key it offers, and
note the public address.

**3. Point the name at the machine.** On the DuckDNS page, put the VM's public
address in the `current ip` box and press update. Check it took effect from your
own machine, because nothing later works until it has:

```bash
dig +short something.duckdns.org
```

**4. Prepare the machine.** SSH in, then:

```bash
git clone <your-repo> passvault && cd passvault
sudo bash deploy/provision.sh
```

That installs Docker and opens 80 and 443 in the machine's own firewall.

**5. Open the ports in Oracle's network too.** This is the step that catches
almost everybody. In the console: **Networking → Virtual Cloud Networks → your
VCN → Subnet → Security List → Add Ingress Rules**, source `0.0.0.0/0`, TCP,
destination ports 80 and 443. The firewall in step 4 was the machine; this is
the network in front of it, and Let's Encrypt has to get through both.

**6. Start it.**

```bash
cd deploy
cp .env.example .env
nano .env          # PASSVAULT_DOMAIN, ACME_EMAIL, and the two DUCKDNS values
docker compose --profile duckdns up -d
```

The `duckdns` profile keeps the record pointed here if the VM's address ever
changes. Leave the profile off if you reserved a static address or bought a
real domain.

**7. Confirm, from your laptop rather than the VM:**

```bash
curl https://something.duckdns.org/health
```

A JSON reply over `https` with no certificate warning means everything is done.

**8. Point the apps at it.** On each device: **Devices → Connection server**,
enter `something.duckdns.org`, **Check it works**, **Save**.

#### When it does not work

| What you see | Almost always |
| --- | --- |
| `curl` hangs or times out | Step 5 — the VCN ingress rule is missing |
| Caddy logs a certificate failure | DNS is not pointing here yet; recheck `dig` |
| Works on the VM, not from outside | Step 5 again, or port 80 blocked upstream |
| `Check it works` says not a PassVault server | Something else is answering on that name |

```bash
docker compose logs -f proxy       # certificate progress
docker compose logs -f signaling   # the server itself
```

### Trying the whole stack before you have a VM

```bash
cd deploy
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
curl http://localhost:8080/health
```

Plain HTTP on port 8080, no domain and no certificate, but the real image behind
the real proxy. It verifies everything a domain has nothing to do with. Take it
down with `docker compose -f docker-compose.yml -f docker-compose.local.yml down -v`.

### Running it, in general

```bash
cd deploy
cp .env.example .env
```

Set `PASSVAULT_DOMAIN` and `ACME_EMAIL` in `.env`, then:

```bash
docker compose up -d
```

Caddy obtains the certificate on first start and renews it from then on. Check
it came up:

```bash
curl https://sync.example.org/health
```

```json
{ "ok": true, "service": "passvault-signaling", "rooms": 0 }
```

`rooms` is a count and never anything more — no room ids, no device ids. There
is nothing else to look at, which is the point.

### Pointing the apps at it

On **each** device: **Devices → Connection server**, enter the hostname, press
**Check it works**, then **Save**. The check confirms the address answers *and*
that it is a PassVault server, rather than leaving you to find out later through
a pairing code that mysteriously will not work.

Devices do not have to agree in advance. A pairing code can name its own server:

```
4F7K-2QX9                     redeemed on the typing device's server
4F7K-2QX9@sync.example.org    redeemed there, wherever the other device points
```

### TLS is not optional

The app refuses plaintext to anything that is not loopback or a `.local` name.
That is deliberate: a pairing offer altered in transit points a device at a
different peer entirely, and TLS is what stops that. There is no override.

### What it does under load

The server is bounded on purpose, because it is reachable by anyone:

| | Limit |
| --- | --- |
| Empty rooms | Swept after 20 minutes; a room with a device waiting in it is never swept |
| Rooms held | 50,000, then `503` |
| Room creation | 20 per client, refilling at 0.5/s |
| Code endpoints | 60 per client, refilling at 2/s |
| WebSocket frame | 256 KB |
| Dead connections | Dropped after two missed 30s pings |
| Container memory | 256 MB |

`TRUST_PROXY=1` is set in compose because Caddy sits in front. Do not set it on
a server exposed directly — without a proxy, the header is client-supplied, and
every client would get to pick its own rate-limit bucket.

### Scaling

Run more containers behind the proxy. State is per-instance, so both devices in
a pair must land on the same one: use sticky sessions, or run one instance and
size it up. One process handles far more than a household needs.

---

## 2. The desktop app

```bash
pnpm --filter @passvault/desktop package:mac
pnpm --filter @passvault/desktop package:win
```

Output lands in `apps/desktop/release/`.

**Build each on its own operating system.** The Windows installer step needs
wine on macOS, and the result cannot be run — let alone tested — by the machine
that produced it. `.github/workflows/release.yml` builds both on native runners
and smoke-tests the Windows app by launching it and checking it creates its
database. Push a `v*` tag to trigger it.

### Signing

Both builds are currently **unsigned**, which is fine for your own machines and
not fine for handing to anyone else:

- **macOS** quarantines an unsigned app downloaded from anywhere. The recipient
  has to clear it by hand, which is exactly the habit not to teach people who
  are installing a password tool.
- **Windows** shows a SmartScreen warning until the signature builds reputation.

To sign later, set these in CI and remove `identity: null` from
`electron-builder.yml`:

| Platform | Secrets |
| --- | --- |
| macOS | `CSC_LINK`, `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` to notarize |
| Windows | `CSC_LINK`, `CSC_KEY_PASSWORD` |

### Icons

None yet, so both builds carry the default Electron icon. Drop `icon.icns` and
`icon.ico` into `apps/desktop/build/` and electron-builder picks them up with no
config change.

---

## 3. Relay, for networks that block direct connections

Most device pairs connect directly using STUN, which needs no setup. A minority
cannot — some mobile carriers and corporate firewalls — and those need a TURN
relay. It forwards encrypted WebRTC traffic it cannot read and keeps nothing
once the session ends.

Run [coturn](https://github.com/coturn/coturn), then fill in **Devices →
Connection server → Add a relay** on each device.

This path is configured and typechecked but **has not been run against a real
coturn deployment**. Treat the first relay connection as untested.

---

## Where this actually stands

Verified on this machine:

- 191 tests, including room sweeping, rate limits, and cross-server codes
- `pnpm demo`, the full stack against real KDBX files
- The macOS `.dmg` for arm64 and x64 — installed, launched, created its SQLite
  database and device key
- The Windows app directory packs with every dependency resolved
- **The Docker image**: builds (254 MB), serves `/health`, creates rooms, issues
  and redeems a pairing code once, relays a WebSocket signal between two peers,
  collects the room when they disconnect, and exits 0 on `SIGTERM`
- **The full compose stack**, proxy included, run locally: WebSockets survive the
  proxy hop, the signaling port is not reachable except through the proxy, and
  the rate limiter cannot be escaped with a forged `X-Forwarded-For`

Not verified:

- The Windows **installer** and the app running on Windows — CI covers both
- TURN against a real relay

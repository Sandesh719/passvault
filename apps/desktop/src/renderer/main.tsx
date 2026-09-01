import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AppSnapshot,
  ConnectionSettings,
  DesktopApi,
  PairedDeviceSummary,
  PairingCode,
  SyncOutcome,
  VersionSummary,
} from "../shared/api.js";
import { normalizeServerHost } from "@passvault/core";
import { PeerBridge } from "./peerBridge.js";
import {
  Body,
  Button,
  Card,
  Heading,
  HeroCard,
  Input,
  Row,
  Step,
  Sub,
  TextArea,
} from "./ui.js";
import "./styles.css";

declare global {
  interface Window {
    readonly passVault: DesktopApi;
  }
}

const api = window.passVault;

type Tab = "home" | "history" | "devices";

/**
 * Relative time, because "3 minutes ago" answers the question people actually
 * have. An ISO timestamp makes them do arithmetic.
 */
function whenever(iso: string): string {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * The message inside an IPC failure, without the plumbing around it.
 *
 * Electron wraps a main-process error as "Error invoking remote method
 * 'settings:save': Error: ...". The useful sentence is at the end; the rest
 * names an internal channel and helps nobody.
 */
function readableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const tail = error.message.split("Error: ").pop()?.trim();
  return tail === undefined || tail.length === 0 ? fallback : tail;
}

/** What the app will actually store, so the field cannot disagree with it. */
function tidyHost(raw: string): string {
  // Left alone when it cannot be read as a host, so the box keeps whatever was
  // typed and the message can explain why rather than silently blanking it.
  return normalizeServerHost(raw) ?? raw.trim();
}

function fileNameOf(path: string | undefined): string {
  return path === undefined ? "" : (path.split("/").pop() ?? path);
}

function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("home");
  const [connection, setConnection] = useState("Starting…");
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [pairing, setPairing] = useState<PairingCode | undefined>(undefined);
  const [enteredCode, setEnteredCode] = useState("");
  const [pairingMode, setPairingMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const bridgeRef = useRef<PeerBridge | undefined>(undefined);
  const readyPeers = useRef(new Set<string>());
  const syncing = useRef(false);

  const refresh = useCallback(async () => {
    setSnapshot(await api.getSnapshot());
  }, []);

  useEffect(() => {
    void refresh();
    return api.onSnapshot(setSnapshot);
  }, [refresh]);

  const pairingModeRef = useRef(pairingMode);
  useEffect(() => {
    pairingModeRef.current = pairingMode;
  }, [pairingMode]);

  const runSync = useCallback(
    async (peerId: string) => {
      if (syncing.current) {
        return;
      }
      syncing.current = true;
      setConnection("Syncing…");
      try {
        const outcome: SyncOutcome = await api.runSession({
          peerId,
          pairingMode: pairingModeRef.current,
        });
        setConnection("Connected");
        if (outcome.kind === "failed") {
          setNotice(outcome.reason);
        }
        setPairingMode(false);
      } finally {
        syncing.current = false;
        void refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    const bridge = new PeerBridge(api, {
      onStatus: setConnection,
      onPeer: (peerId) => {
        readyPeers.current.add(peerId);
        void runSync(peerId);
      },
      onClosed: (peerId) => {
        readyPeers.current.delete(peerId);
        setConnection("Not connected");
      },
    });
    bridgeRef.current = bridge;
    // A configured relay is what makes the connection work on networks where
    // the two devices cannot see each other directly.
    void api.iceServers().then((servers) => bridge.useIceServers(servers));
    return () => bridge.disconnect();
  }, [runSync]);

  // A local save should reach the other device without anyone pressing a button.
  useEffect(
    () =>
      api.onSyncSuggested(() => {
        const peerId = [...readyPeers.current][0];
        if (peerId !== undefined) {
          void runSync(peerId);
        }
      }),
    [runSync],
  );

  const rejoined = useRef(false);
  useEffect(() => {
    if (
      rejoined.current ||
      snapshot === undefined ||
      snapshot.pairedDevices.length === 0
    ) {
      return;
    }
    rejoined.current = true;
    void api.standingRendezvous().then((where) => {
      if (where !== undefined) {
        bridgeRef.current?.connect(where);
        setConnection(`Looking for ${where.peerName}…`);
      }
    });
  }, [snapshot]);

  async function startPairing(): Promise<void> {
    setBusy(true);
    try {
      const code = await api.createPairingCode();
      setPairing(code);
      setPairingMode(true);
      bridgeRef.current?.connect(code);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not start pairing.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function acceptPairing(): Promise<void> {
    setBusy(true);
    try {
      const result = await api.readPairingCode(enteredCode);
      if ("error" in result) {
        setNotice(result.error);
        return;
      }
      setEnteredCode("");
      setPairingMode(true);
      bridgeRef.current?.connect(result);
    } finally {
      setBusy(false);
    }
  }

  async function syncWith(deviceId: string): Promise<void> {
    setPairingMode(false);
    const where = await api.rendezvousFor(deviceId);
    if ("error" in where) {
      setNotice(where.error);
      return;
    }
    bridgeRef.current?.connect(where);
  }

  if (snapshot === undefined) {
    return (
      <div className="grid h-screen place-items-center text-muted">
        Starting…
      </div>
    );
  }

  const conflict = snapshot.conflicts[0];
  const other = snapshot.versions.find((version) => version.canCombine);
  const current = snapshot.versions.find((version) => version.isCurrent);

  return (
    <div className="grid h-screen grid-rows-[auto_1fr]">
      <header className="flex items-center gap-4 border-b border-rule bg-surface px-5 py-3">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden="true" className="size-3 rounded-[3px] bg-accent" />
          <span>PassVault</span>
        </div>
        <nav className="flex gap-1" aria-label="Sections">
          {(
            [
              ["home", "Home"],
              ["history", "History"],
              ["devices", "Devices"],
            ] as const
          ).map(([id, label]) => (
            // Spelled out rather than a Button with overrides: stacking
            // `text-ink` on top of the ghost tone's `text-muted` leaves the
            // winner to Tailwind's output order, not to this file.
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
              className={`cursor-pointer rounded-md border px-3 py-1.5 text-[15px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
                tab === id
                  ? "border-rule bg-sunk text-ink"
                  : "border-transparent bg-transparent text-muted hover:text-accent"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="flex-1" />
        {/* Some statuses are whole sentences; unbounded, one of them shoves the
            device name off the edge of the window. */}
        <span
          title={connection}
          className={`max-w-80 overflow-hidden rounded-full border px-3 py-0.5 text-ellipsis whitespace-nowrap text-[13px] ${
            connection === "Connected"
              ? "border-accent-line text-accent"
              : "border-rule text-muted"
          }`}
        >
          {connection}
        </span>
        <span className="text-[13px] text-faint">{snapshot.device.name}</span>
      </header>

      <main className="mx-auto grid w-full max-w-3xl content-start gap-4 overflow-y-auto px-5 pt-6 pb-12">
        {notice !== undefined ? (
          <div
            role="status"
            className="flex items-center justify-between gap-4 rounded-lg border border-warn-line bg-warn-sunk px-4 py-3 text-sm"
          >
            <span>{notice}</span>
            <Button tone="ghost" onClick={() => setNotice(undefined)}>
              Dismiss
            </Button>
          </div>
        ) : null}

        {/* Above the tabs: the handshake is paused until this is answered, so
            it must not be something the user can navigate away from. */}
        {snapshot.verification !== undefined ? (
          <VerifyCard
            peerName={snapshot.verification.peerName}
            code={snapshot.verification.code}
          />
        ) : null}

        {tab === "home" ? (
          <>
            <StatusCard
              snapshot={snapshot}
              onChooseVault={() => void api.chooseVault()}
              onSaveHere={() => {
                void api.saveVaultAs().then((outcome) => {
                  if (outcome.kind !== "written") {
                    setNotice(outcome.reason);
                  }
                });
              }}
              onApplyPending={() => {
                void api.applyPendingUpdate().then((outcome) => {
                  if (outcome.kind !== "written") {
                    setNotice(outcome.reason);
                  }
                });
              }}
              currentSavedAt={current?.savedAt}
            />

            {conflict !== undefined && other !== undefined ? (
              <ConflictCard
                conflictId={conflict.id}
                otherVersion={other}
                onNotice={setNotice}
              />
            ) : null}

            {snapshot.pairedDevices.length === 0 &&
            snapshot.state.kind !== "needs-setup" ? (
              <Card>
                <Heading>Add your other device</Heading>
                <Body>
                  Nothing is being synced yet because this is the only device
                  set up. Go to <strong className="text-ink">Devices</strong> to
                  connect another one.
                </Body>
                <Button
                  tone="primary"
                  className="justify-self-start"
                  onClick={() => setTab("devices")}
                >
                  Set up another device
                </Button>
              </Card>
            ) : null}

            <details
              open={showDetails}
              onToggle={(event) => setShowDetails(event.currentTarget.open)}
              className="rounded-xl border border-rule bg-surface px-6 py-4"
            >
              <summary className="cursor-pointer text-sm text-muted focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4">
                Recent activity
              </summary>
              <ul className="mt-3 grid max-h-64 gap-1.5 overflow-y-auto text-[13px] text-muted">
                {snapshot.activity.slice(0, 20).map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            </details>
          </>
        ) : null}

        {tab === "history" ? (
          <Card>
            <Heading>Version history</Heading>
            {snapshot.versions.length === 0 ? (
              <p className="m-0 text-faint italic">Nothing saved yet.</p>
            ) : (
              <>
                <Body>
                  Every save is kept. Restoring an older one is always safe —
                  nothing is deleted, and you can come back to where you are
                  now.
                </Body>
                <ul className="grid gap-2">
                  {snapshot.versions.map((version) => (
                    <li
                      key={version.id}
                      className={`flex items-center gap-3 rounded-lg border bg-sunk px-3.5 py-3 ${
                        version.isCurrent ? "border-accent-line" : "border-rule"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`size-2 shrink-0 rounded-full ${
                          version.origin === "you"
                            ? "bg-accent"
                            : version.origin === "peer"
                              ? "bg-peer"
                              : version.origin === "merge"
                                ? "bg-warn"
                                : "bg-faint"
                        }`}
                      />
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <strong className="font-medium text-ink">
                          {version.summary}
                        </strong>
                        <span className="text-[13px] text-faint">
                          {whenever(version.savedAt)}
                          {version.isCurrent ? " · in use now" : ""}
                        </span>
                      </div>
                      {version.isCurrent ? (
                        <span className="rounded-full border border-accent-line px-2.5 py-0.5 text-xs text-accent">
                          In use
                        </span>
                      ) : (
                        <Button
                          onClick={() => void api.restoreVersion(version.id)}
                        >
                          Restore
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        ) : null}

        {tab === "devices" ? (
          <>
            <Card>
              <Heading>Your devices</Heading>
              {snapshot.pairedDevices.length === 0 ? (
                <p className="m-0 text-faint italic">No other devices yet.</p>
              ) : (
                <ul className="grid gap-2">
                  {snapshot.pairedDevices.map((device) => (
                    <DeviceRow
                      key={device.deviceId}
                      device={device}
                      onSyncNow={() => void syncWith(device.deviceId)}
                    />
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <Heading>Connect another device</Heading>
              <Body>
                Do this once per device. Start on one device, then type the code
                on the other.
              </Body>

              <ol className="grid gap-4">
                <Step number={1} title="On this device">
                  <p className="m-0 text-sm text-muted">
                    Get a code to type on the other one.
                  </p>
                  <Button
                    tone="primary"
                    disabled={busy}
                    onClick={() => void startPairing()}
                  >
                    {pairing === undefined ? "Get a code" : "Get a new code"}
                  </Button>
                  {pairing !== undefined ? (
                    <PairingCodePanel pairing={pairing} />
                  ) : null}
                </Step>

                <Step number={2} title="On the other device">
                  <p className="m-0 text-sm text-muted">
                    Type the code there and connect.
                  </p>
                  <Input
                    className="max-w-56 font-mono text-lg tracking-widest uppercase placeholder:normal-case"
                    placeholder="XXXX-XXXX"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={enteredCode}
                    onChange={(event) =>
                      setEnteredCode(event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && enteredCode.length > 0) {
                        void acceptPairing();
                      }
                    }}
                  />
                  <Button
                    disabled={busy || enteredCode.length === 0}
                    onClick={() => void acceptPairing()}
                  >
                    Connect
                  </Button>
                  <Sub>
                    A full link pasted from the other device works here too.
                  </Sub>
                </Step>

                <Step number={3} title="Check the number">
                  <p className="m-0 text-sm text-muted">
                    Both devices then show the same six digits. Confirming they
                    match is what proves you connected to your own device and
                    not to someone in between.
                  </p>
                </Step>
              </ol>
            </Card>

            <ConnectionCard onNotice={setNotice} />
          </>
        ) : null}
      </main>
    </div>
  );
}

/**
 * The six digits, held on screen until they are answered.
 *
 * Nothing has been trusted yet at this point — saying no here leaves no record
 * of the other device behind — which is why the question is worth asking and
 * why it has to wait for a person rather than flash past them.
 */
function VerifyCard(props: {
  readonly peerName: string;
  readonly code: string;
}): React.ReactElement {
  return (
    <Card className="border-warn ring-1 ring-warn/25">
      <Heading>Do these numbers match?</Heading>
      <Body>
        <strong className="text-ink">{props.peerName}</strong> is trying to
        connect. It should be showing exactly this number right now.
      </Body>
      <div className="grid justify-items-center rounded-lg border border-accent-line bg-accent-sunk px-4 py-4">
        <div className="pl-[0.24em] font-mono text-4xl tracking-[0.24em] text-accent">
          {props.code}
        </div>
      </div>
      <Row>
        <Button tone="primary" onClick={() => api.answerVerification(true)}>
          Yes, they match
        </Button>
        <Button onClick={() => api.answerVerification(false)}>
          No — do not connect
        </Button>
      </Row>
      <Sub>
        Nothing is shared until you answer. If the numbers differ, say no: it
        means something is sitting between the two devices.
      </Sub>
    </Card>
  );
}

/**
 * A code short enough to read aloud, with the link kept for the case where the
 * two devices do share a clipboard.
 */
function PairingCodePanel(props: {
  readonly pairing: PairingCode;
}): React.ReactElement {
  const [copied, setCopied] = useState<
    "code" | "qualified" | "link" | undefined
  >(undefined);
  const [showLink, setShowLink] = useState(false);

  function copy(what: "code" | "qualified" | "link", value: string): void {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(undefined), 1500);
    });
  }

  const { shortCode, shortCodeQualified, serverHost } = props.pairing;

  return (
    <div className="grid w-full justify-items-start gap-2.5">
      {shortCode === undefined ? (
        <Sub>
          This connection server does not hand out short codes, so use the link
          below.
        </Sub>
      ) : (
        <>
          {/* Read off one screen and typed into another, so a stray double-click
              must not select half of it. */}
          <div className="rounded-lg border border-accent-line bg-accent-sunk px-4 py-2.5 font-mono text-3xl font-semibold tracking-[0.14em] text-accent select-all">
            {shortCode}
          </div>
          <Row>
            <Button small onClick={() => copy("code", shortCode)}>
              {copied === "code" ? "Copied" : "Copy code"}
            </Button>
            <span className="text-[13.5px] text-faint">
              Type this on your other device. It lasts ten minutes.
            </span>
          </Row>
          {/* The code alone only means something to the server holding it. Say
              which one that is, so a device set to a different server has
              something it can actually use. */}
          <Sub>
            Held on <strong className="text-muted">{serverHost}</strong>. If
            your other device uses a different connection server, type the
            longer form there instead:
          </Sub>
          {shortCodeQualified === undefined ? null : (
            <Row>
              <code className="rounded-md border border-rule bg-sunk px-2.5 py-1.5 font-mono text-[13px] break-all text-ink select-all">
                {shortCodeQualified}
              </code>
              <Button
                small
                onClick={() => copy("qualified", shortCodeQualified)}
              >
                {copied === "qualified" ? "Copied" : "Copy"}
              </Button>
            </Row>
          )}
        </>
      )}

      <Button tone="ghost" small onClick={() => setShowLink(!showLink)}>
        {showLink ? "Hide the link" : "Use a link instead"}
      </Button>
      {showLink ? (
        <>
          <TextArea
            readOnly
            rows={3}
            value={props.pairing.code}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button small onClick={() => copy("link", props.pairing.code)}>
            {copied === "link" ? "Copied" : "Copy link"}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Where this device meets other devices.
 *
 * The one setting that has to be right for two devices in different places to
 * find each other at all, so it says what it is for in plain words rather than
 * being labelled "signaling server" and left to be guessed at.
 */
function ConnectionCard(props: {
  readonly onNotice: (message: string) => void;
}): React.ReactElement {
  const [settings, setSettings] = useState<ConnectionSettings | undefined>(
    undefined,
  );
  const [host, setHost] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<
    { ok: boolean; detail: string } | undefined
  >(undefined);
  const [showRelay, setShowRelay] = useState(false);
  const [relay, setRelay] = useState({ url: "", username: "", credential: "" });

  useEffect(() => {
    void api.connectionSettings().then((loaded) => {
      setSettings(loaded);
      setHost(loaded.serverHost);
      setRelay({
        url: loaded.turnUrl ?? "",
        username: loaded.turnUsername ?? "",
        credential: loaded.turnCredential ?? "",
      });
    });
  }, []);

  if (settings === undefined) {
    return (
      <Card>
        <Body>Loading…</Body>
      </Card>
    );
  }

  const changed =
    host.trim() !== settings.serverHost ||
    relay.url.trim() !== (settings.turnUrl ?? "") ||
    relay.username.trim() !== (settings.turnUsername ?? "") ||
    relay.credential !== (settings.turnCredential ?? "");

  function save(): void {
    void api
      .saveConnectionSettings({
        serverHost: host.trim(),
        ...(relay.url.trim().length === 0
          ? {}
          : {
              turnUrl: relay.url.trim(),
              turnUsername: relay.username.trim(),
              turnCredential: relay.credential,
            }),
      })
      .then((saved) => {
        setSettings(saved);
        setResult({
          ok: true,
          detail: `Saved. This device now meets others at ${saved.serverHost}.`,
        });
      })
      .catch((error: unknown) =>
        props.onNotice(readableError(error, "Could not save that.")),
      );
  }

  return (
    <Card>
      <Heading>Connection server</Heading>
      <Body>
        Two devices find each other through a server they both reach. It only
        introduces them — your passwords never pass through it, and it cannot
        read them.
      </Body>
      <Sub>
        For devices in different places, set{" "}
        <strong className="text-muted">both</strong> to the same address. Leave
        it as it is if they are on the same network. Pasting the full{" "}
        <code className="text-muted">https://…</code> address works too.
      </Sub>

      <Row>
        <Input
          className="min-w-56 flex-1"
          value={host}
          spellCheck={false}
          placeholder="sync.example.org"
          onChange={(event) => setHost(event.currentTarget.value)}
          // Pasting a whole URL is the normal thing to do; show the bare host
          // that will actually be stored rather than saving something that
          // does not match what is on screen.
          onBlur={(event) => setHost(tidyHost(event.currentTarget.value))}
        />
        <Button
          disabled={testing || host.trim().length === 0}
          onClick={() => {
            setTesting(true);
            setResult(undefined);
            void api
              .testConnectionServer(host.trim())
              .then(setResult)
              .finally(() => setTesting(false));
          }}
        >
          {testing ? "Checking…" : "Check it works"}
        </Button>
      </Row>

      {result === undefined ? null : (
        <p
          className={`m-0 text-[13.5px] ${result.ok ? "text-accent" : "text-warn"}`}
        >
          {result.detail}
        </p>
      )}

      <Button
        tone="ghost"
        small
        className="justify-self-start"
        onClick={() => setShowRelay(!showRelay)}
      >
        {showRelay
          ? "Hide relay settings"
          : "Add a relay (for restrictive networks)"}
      </Button>

      {showRelay ? (
        <div className="grid gap-2.5 border-t border-rule pt-3">
          <Sub>
            Most connections go straight between the two devices. A few networks
            — some office and mobile ones — block that. A relay forwards the
            encrypted traffic for those, without being able to read it or
            keeping a copy.
          </Sub>
          <Input
            value={relay.url}
            spellCheck={false}
            placeholder="turn:relay.example.org:3478"
            onChange={(event) =>
              setRelay({ ...relay, url: event.currentTarget.value })
            }
          />
          <Row>
            <Input
              className="min-w-40 flex-1"
              value={relay.username}
              spellCheck={false}
              placeholder="Relay username"
              onChange={(event) =>
                setRelay({ ...relay, username: event.currentTarget.value })
              }
            />
            <Input
              className="min-w-40 flex-1"
              type="password"
              value={relay.credential}
              placeholder="Relay password"
              onChange={(event) =>
                setRelay({ ...relay, credential: event.currentTarget.value })
              }
            />
          </Row>
        </div>
      ) : null}

      <Button
        tone="primary"
        className="justify-self-start"
        disabled={!changed}
        onClick={save}
      >
        Save
      </Button>
    </Card>
  );
}

/**
 * Disconnecting and forgetting are different promises, so they are different
 * buttons with the consequence written on each.
 */
function DeviceRow(props: {
  readonly device: PairedDeviceSummary;
  readonly onSyncNow: () => void;
}): React.ReactElement {
  const { device } = props;
  const [confirming, setConfirming] = useState(false);
  const paused = device.trust === "revoked";

  return (
    <li
      className={`flex items-center gap-3 rounded-lg border bg-sunk px-3.5 py-3 ${
        paused ? "border-dashed border-rule opacity-70" : "border-rule"
      }`}
    >
      <div className="grid min-w-0 flex-1 gap-0.5">
        <strong className="font-medium text-ink">{device.name}</strong>
        <span className="text-[13px] text-faint">
          {paused
            ? "Disconnected — not syncing. You can reconnect it."
            : device.lastSeenAt === undefined
              ? "Connected, not synced yet"
              : `Last synced ${whenever(device.lastSeenAt)}`}
        </span>
      </div>

      {confirming ? (
        <Row>
          <span className="text-[13px] text-faint">Forget it completely?</span>
          <Button onClick={() => void api.forgetDevice(device.deviceId)}>
            Yes, forget it
          </Button>
          <Button tone="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </Row>
      ) : paused ? (
        <Row>
          <Button onClick={() => void api.reconnectDevice(device.deviceId)}>
            Reconnect
          </Button>
          <Button
            tone="ghost"
            title="Erase this device. Connecting it again means comparing numbers from scratch."
            onClick={() => setConfirming(true)}
          >
            Forget
          </Button>
        </Row>
      ) : (
        <Row>
          <Button
            disabled={!device.canReconnect}
            title={
              device.canReconnect
                ? "Connect and sync now"
                : "This device was connected before reconnecting was supported. Connect it again."
            }
            onClick={props.onSyncNow}
          >
            Sync now
          </Button>
          <Button
            tone="ghost"
            title="Stop syncing for now. You can turn it back on here at any time."
            onClick={() => void api.disconnectDevice(device.deviceId)}
          >
            Disconnect
          </Button>
        </Row>
      )}
    </li>
  );
}

function StatusCard(props: {
  readonly snapshot: AppSnapshot;
  readonly onChooseVault: () => void;
  readonly onSaveHere: () => void;
  readonly onApplyPending: () => void;
  readonly currentSavedAt: string | undefined;
}): React.ReactElement {
  const { state, vault } = props.snapshot;

  if (state.kind === "needs-setup") {
    return (
      <HeroCard tone="neutral">
        <Heading>Set up syncing</Heading>
        <Body>
          Keep one password file in step across your devices. KeePassXC still
          manages your passwords — this only moves the file between machines,
          and it stays encrypted the whole way.
        </Body>
        <div className="grid justify-items-start gap-2.5">
          <Button tone="primary" onClick={props.onChooseVault}>
            My password file is on this device
          </Button>
          <Sub>
            If it is on another device instead, set that one up first, then
            connect this one from the{" "}
            <strong className="text-muted">Devices</strong> tab — the file will
            arrive by itself.
          </Sub>
        </div>
      </HeroCard>
    );
  }

  if (state.kind === "needs-file") {
    return (
      <HeroCard tone="attention">
        <Heading>Almost there</Heading>
        <Body>
          <strong className="text-ink">{state.vaultName}</strong> arrived from
          your other device. Choose where to keep it on this machine, then open
          that file in KeePassXC.
        </Body>
        <Button
          tone="primary"
          className="justify-self-start"
          onClick={props.onSaveHere}
        >
          Save it on this device
        </Button>
      </HeroCard>
    );
  }

  if (state.kind === "waiting-for-close") {
    return (
      <HeroCard tone="attention">
        <Heading>Waiting for KeePassXC</Heading>
        <Body>
          There is a newer version ready, but KeePassXC currently has{" "}
          <strong className="text-ink">{fileNameOf(vault?.kdbxPath)}</strong>{" "}
          open. Close it and the file will update.
        </Body>
        <Button className="justify-self-start" onClick={props.onApplyPending}>
          I closed it — update now
        </Button>
      </HeroCard>
    );
  }

  if (state.kind === "conflict") {
    return (
      <HeroCard tone="attention">
        <Heading>Both devices changed things</Heading>
        <Body>
          Nothing has been lost. Combine them below to keep every change from
          both devices.
        </Body>
      </HeroCard>
    );
  }

  return (
    <HeroCard tone="good">
      <Heading>Everything is in sync</Heading>
      <Body>
        <strong className="text-ink">{fileNameOf(vault?.kdbxPath)}</strong> is
        up to date
        {props.currentSavedAt === undefined
          ? ""
          : ` · last change ${whenever(props.currentSavedAt)}`}
        .
      </Body>
      <Sub>
        Saves in KeePassXC are picked up automatically and sent to your other
        devices.
      </Sub>
    </HeroCard>
  );
}

/**
 * The one screen where a wrong choice loses work, so it leads with the safe
 * option and spells out what the others actually do.
 */
function ConflictCard(props: {
  readonly conflictId: string;
  readonly otherVersion: VersionSummary;
  readonly onNotice: (message: string) => void;
}): React.ReactElement {
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [showOneSided, setShowOneSided] = useState(false);

  return (
    <Card>
      <Heading>Combine the changes</Heading>
      <Body>
        Your other device saved changes too (
        {whenever(props.otherVersion.savedAt)}). Combining keeps both — entries
        added on either device all end up in one file.
      </Body>
      <Sub>
        This needs your master password once, only to open the two files and
        write the combined one. It is not stored.
      </Sub>

      <Row>
        <Input
          className="min-w-56 flex-1"
          type="password"
          placeholder="Master password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && password.length > 0) {
              event.currentTarget.blur();
            }
          }}
        />
        <Button
          tone="primary"
          disabled={password.length === 0 || working}
          onClick={() => {
            setWorking(true);
            void api
              .combineAndUse({
                otherVersionId: props.otherVersion.id,
                password,
              })
              .then((result) => {
                setPassword("");
                if (result.kind !== "merged") {
                  props.onNotice(result.reason);
                }
              })
              .finally(() => setWorking(false));
          }}
        >
          {working ? "Combining…" : "Combine and keep both"}
        </Button>
      </Row>

      <Button
        tone="ghost"
        small
        className="justify-self-start"
        onClick={() => setShowOneSided(!showOneSided)}
      >
        {showOneSided ? "Hide other options" : "Other options"}
      </Button>

      {showOneSided ? (
        <div className="grid gap-2.5 border-t border-rule pt-3">
          <Sub>
            These pick a winner instead of combining, and they only change{" "}
            <em>this</em> device. If both devices pick opposite sides you will
            simply swap and still be out of step — which is why combining is the
            recommended path.
          </Sub>
          <Row>
            <Button
              onClick={() =>
                void api.resolveConflict({
                  conflictId: props.conflictId,
                  decision: "keep-current",
                })
              }
            >
              Keep only this device&rsquo;s version
            </Button>
            <Button
              onClick={() =>
                void api.resolveConflict({
                  conflictId: props.conflictId,
                  decision: "switch-incoming",
                })
              }
            >
              Use only the other device&rsquo;s version
            </Button>
          </Row>
        </div>
      ) : null}
    </Card>
  );
}

const root = document.querySelector("#root");
if (root !== null) {
  createRoot(root).render(<App />);
}

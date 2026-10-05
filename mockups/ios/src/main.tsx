import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowUp,
  ArrowRight,
  Plus,
  Settings,
  Monitor,
  Server,
  QrCode,
  Terminal,
  Wifi,
  ChevronRight,
  Check,
  X,
  Paperclip,
  AtSign,
  MessageSquare,
  Globe,
  ShieldCheck,
  Camera,
  KeyRound,
  RefreshCw,
  Bell,
  Lock,
  Image,
  MoreHorizontal,
  Signal,
  BatteryFull,
  Fingerprint,
  Folder,
  Command,
  Eye,
  CircleAlert,
  Radio,
  Laptop,
  Moon,
  Sun,
} from "lucide-react";
import "./styles.css";

export const screens = [
  ["welcome", "Add a host"],
  ["qr", "Scan QR"],
  ["ssh", "Connect with SSH"],
  ["fingerprint", "Verify fingerprint"],
  ["nearby", "Nearby hosts"],
  ["hosts", "Your hosts"],
  ["threads", "Workspace & threads"],
  ["chat", "Shared chat"],
  ["approval", "Approval notification"],
  ["command", "Command approval"],
  ["terminal", "Terminal · read-only"],
  ["terminal-full", "Terminal · full access"],
  ["browser", "Browser · view"],
  ["browser-control", "Browser · control"],
  ["settings", "Device settings"],
  ["connecting", "Connecting"],
  ["reconnecting", "Catching up"],
  ["offline", "Host offline"],
  ["denied", "Permission denied"],
  ["expired", "Pairing expired"],
] as const;
type Screen = (typeof screens)[number][0];
const hostData = [
  {
    name: "Tyler’s MacBook",
    kind: "Desktop",
    route: "LAN",
    online: true,
    meta: "Connected · just now",
    Icon: Monitor,
  },
  {
    name: "Apex build server",
    kind: "Daemon",
    route: "SSH",
    online: true,
    meta: "Last opened 12 minutes ago",
    Icon: Server,
  },
  {
    name: "Studio Mac mini",
    kind: "Desktop",
    route: "Relay",
    online: false,
    meta: "Last seen yesterday, 8:42 PM",
    Icon: Monitor,
  },
];
function App() {
  const initial = () => {
    const id = location.hash.slice(1);
    return (screens.some(([key]) => key === id) ? id : "hosts") as Screen;
  };
  const [screen, setScreen] = useState<Screen>(initial),
    [light, setLight] = useState(false),
    [large, setLarge] = useState(false),
    [host, setHost] = useState("Tyler’s MacBook"),
    [pairMethod, setPairMethod] = useState("QR"),
    [sheet, setSheet] = useState(""),
    [notice, setNotice] = useState(""),
    [decision, setDecision] = useState(""),
    [draft, setDraft] = useState(""),
    [messages, setMessages] = useState<string[]>([]),
    [attachment, setAttachment] = useState(false),
    [key, setKey] = useState(""),
    [notifications, setNotifications] = useState(true),
    [unpaired, setUnpaired] = useState(false),
    [streamDone, setStreamDone] = useState(false),
    [reply, setReply] = useState(
      "I’ll keep the host identity visible while you switch between",
    );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const touch = useRef(0),
    main = useRef<HTMLElement>(null),
    sheetRef = useRef<HTMLDivElement>(null),
    lastFocus = useRef<HTMLElement | null>(null);
  const go = (next: Screen) => {
    location.hash = next;
    setSheet("");
    setDecision("");
    setNotice("");
  };
  useEffect(() => {
    const onHash = () => {
      setScreen(initial());
      setDecision("");
      setSheet("");
      main.current?.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (screen !== "chat") return;
    const full =
      "I’ll keep the host identity visible while you switch between chat, terminal, and browser. The desktop remains the source of truth.";
    let i = 76;
    setStreamDone(false);
    setReply(full.slice(0, i));
    const timer = setInterval(() => {
      i += 2;
      setReply(full.slice(0, i));
      if (i >= full.length) {
        clearInterval(timer);
        setStreamDone(true);
      }
    }, 180);
    return () => clearInterval(timer);
  }, [screen]);
  useEffect(() => {
    if (!sheet) return;
    lastFocus.current = document.activeElement as HTMLElement;
    sheetRef.current?.querySelector<HTMLElement>("button")?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet("");
      if (e.key === "Tab") {
        const nodes =
          sheetRef.current?.querySelectorAll<HTMLElement>("button,input");
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      lastFocus.current?.focus();
    };
  }, [sheet]);
  const back: Partial<Record<Screen, Screen>> = {
    welcome: "hosts",
    qr: "welcome",
    ssh: "welcome",
    fingerprint: "ssh",
    nearby: "welcome",
    threads: "hosts",
    chat: "threads",
    approval: "chat",
    command: "chat",
    terminal: "chat",
    "terminal-full": "chat",
    browser: "chat",
    "browser-control": "chat",
    settings: "hosts",
    connecting: "hosts",
    reconnecting: "chat",
    offline: "hosts",
    denied: "settings",
    expired: "qr",
  };
  const button = (label: string, action: () => void, cls = "") => (
    <button className={cls} onClick={action}>
      {label}
    </button>
  );
  const row = (
    Icon: typeof Monitor,
    title: string,
    sub: string,
    action: () => void,
    badge?: string,
  ) => (
    <button className="row" onClick={action}>
      <span className="row-icon">
        <Icon size={23} />
      </span>
      <span className="row-copy">
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
      {badge && <span className="badge">{badge}</span>}
      <ChevronRight size={18} />
    </button>
  );
  const approval = (command = false) => (
    <section className="approval-card" aria-label="Tool call approval">
      <div className="eyebrow amber">
        <ShieldCheck size={15} /> APPROVAL REQUIRED
      </div>
      <h3>{command ? "Run workspace tests" : "Update the navigation"}</h3>
      <p className="muted">
        Codex wants to {command ? "run a command" : "edit a file"} in Apex Deck.
      </p>
      <div className="file-label">
        <Folder size={15} />
        {command ? "~/Projects/apex-deck" : "src/mobile/Navigation.tsx"}
      </div>
      <pre className="diff">
        {command ? (
          <>
            <span>$ npm test</span>
            {"\n\n"}
            <span className="muted">
              Working directory: apex-deck{"\n"}Network access: none requested
            </span>
          </>
        ) : (
          <>
            <span className="muted">@@ navigation · line 24</span>
            {"\n"}
            <span className="removed">− showDesktopSidebar();</span>
            {"\n"}
            <span className="added">+ showHostBreadcrumb();</span>
            {"\n"}
            <span className="added">+ showThreadSwitcher();</span>
          </>
        )}
      </pre>
      <p className="scope">
        “Always” allows {command ? "this exact command" : "edits to this file"}{" "}
        by Codex in this thread. It does not apply to other hosts.
      </p>
      {decision ? (
        <div className="result" role="status">
          <Check size={18} />
          {decision} · mock decision
        </div>
      ) : (
        <>
          <div className="actions">
            {button("Deny", () => setDecision("Denied"), "danger")}
            {button(
              "Approve once",
              () => setDecision("Approved once"),
              "primary",
            )}
          </div>
          {button(
            "Always allow…",
            () => setSheet(command ? "always-command" : "always"),
            "wide plain",
          )}
        </>
      )}
    </section>
  );
  const threadNav = [
    "chat",
    "terminal",
    "terminal-full",
    "browser",
    "browser-control",
  ].includes(screen);
  return (
    <div className={`review ${light ? "light" : ""} ${large ? "large" : ""}`}>
      <aside className="review-index">
        <a className="wordmark" href="#hosts">
          <span className="brand-symbol">✳</span> apex deck
          <span className="edition">iOS</span>
        </a>
        <div className="eyebrow">DESIGN REVIEW / 01</div>
        <h1>
          Your Deck.
          <br />
          Within reach.
        </h1>
        <p>
          A remote window into the agents,
          <br />
          workspaces, and tools on your host.
        </p>
        <div className="review-controls">
          {button(light ? "Light" : "Dark", () => setLight(!light), "mode")}
          {button(
            large ? "Type: large" : "Type: default",
            () => setLarge(!large),
            "mode",
          )}
        </div>
        <nav aria-label="Mockup screen index">
          {screens.map(([id, label], i) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={screen === id ? "page" : undefined}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {label}
              {screen === id && <ArrowRight size={14} />}
            </a>
          ))}
        </nav>
        <p className="review-note">
          Clickable mock data · 393 × 852
          <br />
          No host connection or backend.
        </p>
      </aside>
      <div className="stage">
        <div className="stage-meta">
          <span>APEX DECK / REMOTE CLIENT</span>
          <span>{light ? "LIGHT" : "DARK"} APPEARANCE</span>
        </div>
        <div
          className="phone"
          onTouchStart={(e) => {
            touch.current = e.touches[0].clientX;
          }}
          onTouchEnd={(e) => {
            if (
              touch.current < 75 &&
              e.changedTouches[0].clientX - touch.current > 90 &&
              back[screen]
            )
              go(back[screen]!);
          }}
        >
          <div className="status-bar" aria-hidden="true">
            <strong>9:41</strong>
            <div className="island" />
            <span>
              <Signal size={16} />
              <Wifi size={16} />
              <BatteryFull size={22} />
            </span>
          </div>
          <header className="phone-header" inert={!!sheet}>
            {back[screen] ? (
              <button
                className="back"
                aria-label={`Back to ${back[screen]}`}
                onClick={() => go(back[screen]!)}
              >
                <ArrowLeft size={20} />
                <span>
                  {[
                    "chat",
                    "terminal",
                    "terminal-full",
                    "browser",
                    "browser-control",
                  ].includes(screen)
                    ? "Threads"
                    : "Back"}
                </span>
              </button>
            ) : (
              <span className="brand-mini">✳ apex deck</span>
            )}
            <span className="header-right">
              {screen === "hosts" ? (
                <button
                  className="icon-button"
                  aria-label="Device settings"
                  onClick={() => go("settings")}
                >
                  <Settings size={21} />
                </button>
              ) : (
                <span className="connection">
                  <i />
                  {screen === "offline"
                    ? "OFFLINE"
                    : screen === "connecting"
                      ? "CONNECTING"
                      : screen === "reconnecting"
                        ? "SYNCING"
                        : host === "Apex build server"
                          ? "SSH"
                          : "LAN"}
                </span>
              )}
            </span>
          </header>
          <main
            inert={!!sheet}
            ref={main}
            className={`phone-content ${screen === "chat" ? "chat-content" : ""}`}
          >
            {screen === "welcome" && (
              <>
                <div className="hero-mark">✳</div>
                <div className="eyebrow mint">YOUR HOST. ANYWHERE.</div>
                <h2>Add your Deck</h2>
                <p className="intro">
                  Your agents stay on your computer.
                  <br />
                  Bring the conversation with you.
                </p>
                <div className="group">
                  {row(
                    QrCode,
                    "Scan a QR code",
                    "Pair from your desktop in seconds",
                    () => {
                      setPairMethod("QR");
                      go("qr");
                    },
                  )}
                  {row(
                    Terminal,
                    "Connect with SSH",
                    "Use an existing host and key",
                    () => {
                      setPairMethod("SSH");
                      go("ssh");
                    },
                  )}
                  {row(
                    Wifi,
                    "Find a nearby host",
                    "Discover Deck on your Wi-Fi",
                    () => {
                      setPairMethod("LAN");
                      go("nearby");
                    },
                  )}
                </div>
                <p className="footnote">
                  <Lock size={14} /> Your host grants this device access.
                  <br />
                  You can revoke it at any time.
                </p>
              </>
            )}
            {screen === "qr" && (
              <>
                <h2>Scan to pair</h2>
                <p className="intro">
                  On your host, open Settings → Devices
                  <br />
                  or run <code>apex-daemon pair</code>.
                </p>
                <div className="viewfinder">
                  <Camera size={38} />
                  <span>Camera preview placeholder</span>
                  <div className="scan-corners" />
                </div>
                <p className="footnote">
                  One-time code · expires after 5 minutes
                  <br />
                  <code>apexdeck://pair?…</code>
                </p>
                {button(
                  "Simulate QR scan",
                  () => go("fingerprint"),
                  "primary wide",
                )}
                {button("Use a new code", () => go("expired"), "plain wide")}
              </>
            )}
            {screen === "ssh" && (
              <>
                <h2>Connect with SSH</h2>
                <p className="intro">A direct connection to your Deck host.</p>
                <div className="form">
                  <label>
                    Host
                    <input defaultValue="apex.local" autoCapitalize="none" />
                  </label>
                  <div className="form-split">
                    <label>
                      Port
                      <input defaultValue="22" inputMode="numeric" />
                    </label>
                    <label>
                      User
                      <input defaultValue="tyler" autoCapitalize="none" />
                    </label>
                  </div>
                  <div className="input-caption">SSH key</div>
                  {row(
                    KeyRound,
                    key || "Choose a key",
                    "Imported keys stay on this device",
                    () => setSheet("keys"),
                  )}
                  {button(
                    "Generate a device key",
                    () => {
                      setKey("iPhone · ed25519 (mock)");
                      setNotice(
                        "Mock key created. In the real app, add its public key on your host.",
                      );
                    },
                    "plain wide",
                  )}
                  <p className="footnote">
                    This preview does not read or create keys.
                  </p>
                </div>
                {button(
                  "Continue",
                  () => {
                    setPairMethod("SSH");
                    go("fingerprint");
                  },
                  "primary wide",
                )}
              </>
            )}
            {screen === "fingerprint" && (
              <>
                <div className="hero-mark small">
                  <Fingerprint size={42} />
                </div>
                <h2>Verify your host</h2>
                <p className="intro">
                  Compare this fingerprint with the one
                  <br />
                  shown on your host before pairing.
                </p>
                <div className="group padded">
                  <span className="eyebrow">HOST IDENTITY</span>
                  <h3>{host}</h3>
                  <p className="muted">
                    Ed25519 ·{" "}
                    {pairMethod === "SSH" ? "SSH host key" : "device pairing"}
                  </p>
                  <pre className="fingerprint">
                    SHA256:7FvK2mR9bT4xP6nA{"\n"}3cH8qW1zE5sD0uJ9yL2kG6vN
                  </pre>
                  <span className="badge">Requested: chat + approvals</span>
                </div>
                <p className="footnote">
                  The host decides your permission level.
                  <br />
                  Only continue if the fingerprints match.
                </p>
                {button(
                  "Fingerprints match · pair",
                  () => {
                    setUnpaired(false);
                    go("hosts");
                    setNotice(
                      "Mock pairing complete · chat + approvals granted",
                    );
                  },
                  "primary wide",
                )}
                {button("Cancel pairing", () => go("welcome"), "plain wide")}
              </>
            )}
            {screen === "nearby" && (
              <>
                <h2>Nearby Decks</h2>
                <p className="intro">
                  Hosts announcing themselves on your Wi-Fi.
                </p>
                <div className="discovery">
                  <Radio size={26} />
                  <span>Looking on your local network</span>
                </div>
                <div className="group">
                  {row(
                    Monitor,
                    "Tyler’s MacBook",
                    "Desktop · apex-macbook.local",
                    () => {
                      setHost("Tyler’s MacBook");
                      go("fingerprint");
                    },
                  )}
                  {row(
                    Server,
                    "Apex build server",
                    "Daemon · apex-build.local",
                    () => {
                      setHost("Apex build server");
                      go("fingerprint");
                    },
                  )}
                </div>
                <p className="footnote">
                  Discovery is not authorization. Confirm the
                  <br />
                  host identity and approve this device there.
                </p>
                {button(
                  "Don’t see your host? Use SSH",
                  () => go("ssh"),
                  "plain wide",
                )}
              </>
            )}
            {screen === "hosts" && (
              <>
                <div className="title-row">
                  <h2>Your hosts</h2>
                  <button
                    className="icon-button mint"
                    aria-label="Add a host"
                    onClick={() => go("welcome")}
                  >
                    <Plus size={25} />
                  </button>
                </div>
                <p className="intro">Pick up where your agents left off.</p>
                <div className="section-label">
                  PAIRED WITH THIS DEVICE <span>{unpaired ? "2" : "3"}</span>
                </div>
                <div className="host-cards">
                  {hostData
                    .filter((h) => !unpaired || h.name !== "Tyler’s MacBook")
                    .map((h) => (
                      <button
                        key={h.name}
                        className="host-card"
                        onClick={() => {
                          setHost(h.name);
                          go(h.online ? "threads" : "offline");
                        }}
                      >
                        <div className="host-top">
                          <span className="host-icon">
                            <h.Icon size={26} />
                          </span>
                          <span className="badge">{h.kind}</span>
                          <span
                            className={`host-state ${h.online ? "mint" : "muted"}`}
                          >
                            {h.online ? "● Online" : "○ Offline"}
                          </span>
                        </div>
                        <h3>{h.name}</h3>
                        <p>{h.meta}</p>
                        <div className="host-bottom">
                          <span>
                            {h.route.toUpperCase()}{" "}
                            <span className="muted">
                              {h.online
                                ? "· Encrypted connection"
                                : "· Not connected"}
                            </span>
                          </span>
                          <ChevronRight size={18} />
                        </div>
                      </button>
                    ))}
                </div>
                <div className="quiet-note">
                  <ShieldCheck size={18} />
                  <span>
                    Your work runs on your host.
                    <br />
                    This phone is your remote.
                  </span>
                </div>
              </>
            )}
            {screen === "threads" && (
              <>
                <div className="eyebrow mint">{host.toUpperCase()}</div>
                <h2>Workspaces</h2>
                <button
                  className="workspace"
                  onClick={() => setSheet("workspaces")}
                >
                  <Folder size={21} />
                  <span>
                    <strong>Apex Deck</strong>
                    <small>~/Projects/apex-deck</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
                <div className="section-label">
                  THREADS <span>4</span>
                </div>
                <div className="group threads">
                  {[
                    [
                      "Mobile navigation",
                      "Waiting for approval",
                      "Codex · Claude",
                      "amber",
                      "2",
                    ],
                    [
                      "Remote host protocol",
                      "Running",
                      "Codex · Gemini",
                      "mint",
                      "1",
                    ],
                    ["Polish the composer", "Idle", "Claude", "muted", ""],
                    ["Preview regression", "Error", "Codex", "red", ""],
                  ].map(([title, status, agents, color, unread]) => (
                    <button
                      className="thread-row"
                      key={title}
                      onClick={() => {
                        go("chat");
                        if (status === "Error")
                          setNotice(
                            "Mock error: preview process exited. Your transcript is preserved.",
                          );
                      }}
                    >
                      <div>
                        <strong>{title}</strong>
                        {unread && (
                          <b
                            className="unread"
                            aria-label={`${unread} unread messages`}
                          >
                            {unread}
                          </b>
                        )}
                      </div>
                      <p className={color}>
                        <i className="dot" />
                        {status}
                      </p>
                      <small>
                        {agents}
                        <span>2m ago</span>
                      </small>
                    </button>
                  ))}
                </div>
                <p className="footnote">
                  Every participant shares one conversation.
                </p>
              </>
            )}
            {screen === "chat" && (
              <>
                <div className="chat-context">{host} / Apex Deck</div>
                <div className="chat-heading">
                  <h2>Mobile navigation</h2>
                  <button
                    className="icon-button"
                    aria-label="Thread participants"
                    onClick={() => setSheet("agents")}
                  >
                    <MoreHorizontal size={22} />
                  </button>
                </div>
                <button
                  className="participants"
                  onClick={() => setSheet("agents")}
                >
                  <span className="avatar codex">C</span>
                  <span className="avatar claude">✳</span>
                  <span>
                    Codex + Claude <small>· Reply when mentioned</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
                <div className="date-label">TODAY, 9:38 AM</div>
                <article className="message human">
                  <div className="message-by">
                    You <time>9:38</time>
                  </div>
                  <p>
                    Let’s make the phone feel like Deck. Keep the host clear,
                    and the controls close.
                  </p>
                  <button
                    className="attachment"
                    aria-label="Open attached navigation sketch"
                    onClick={() => setSheet("image")}
                  >
                    <img
                      src="/preview.svg"
                      alt="Navigation sketch with a host list and agent thread"
                    />
                    <span>
                      <Image size={13} /> navigation-sketch.png
                    </span>
                  </button>
                </article>
                <article className="message">
                  <div className="message-by">
                    <span className="avatar claude">✳</span>Claude{" "}
                    <span className="model-label">Sonnet</span>
                    <time>9:39</time>
                  </div>
                  <p>
                    Keep a simple drill-down:{" "}
                    <strong>host → thread → conversation.</strong> Tools stay
                    one tap away.
                  </p>
                </article>
                <article className="message">
                  <div className="message-by">
                    <span className="avatar codex">C</span>Codex{" "}
                    <span className="model-label">GPT</span>
                    <span className="stream-label">
                      {streamDone ? "✓ Finished" : "● Writing"}
                    </span>
                  </div>
                  <p>
                    {reply}
                    {!streamDone && <span className="cursor" />}
                  </p>
                </article>
                {approval()}
                {messages.map((m, i) => (
                  <article className="message human" key={i}>
                    <div className="message-by">
                      You <time>Now</time>
                    </div>
                    <p>{m}</p>
                  </article>
                ))}
              </>
            )}
            {(screen === "approval" || screen === "command") && (
              <>
                <div className="eyebrow amber">FROM A NOTIFICATION</div>
                <h2>Review request</h2>
                <p className="intro">
                  {host}
                  <br />
                  Apex Deck / Mobile navigation
                </p>
                <div className="request-agent">
                  <span className="avatar codex">C</span>
                  <span>
                    <strong>Codex</strong>
                    <small>Waiting for you · 9:40 AM</small>
                  </span>
                </div>
                {approval(screen === "command")}
                {button("View conversation", () => go("chat"), "plain wide")}
              </>
            )}
            {(screen === "terminal" || screen === "terminal-full") && (
              <>
                <h2 className="compact-title">Terminal</h2>
                <p className="intro">Apex Deck · shell 01</p>
                <div className="terminal-status">
                  <Eye size={16} />
                  {screen === "terminal"
                    ? "Read-only · output from your host"
                    : "Full permission · input enabled"}
                </div>
                <pre className="terminal-output">
                  <span className="mint">tyler@apex-macbook</span>
                  {" ~/apex-deck\n❯ npm run build\n\n"}
                  <span className="muted">{"vite v6.0.5 building…\n"}</span>
                  {
                    "✓ 128 modules transformed.\ndist/index.html    0.48 kB\ndist/assets/app.js  92.4 kB\n\n"
                  }
                  <span className="mint">✓ built in 1.34s</span>
                  {"\n\n❯ "}
                  {screen === "terminal-full" ? (
                    <span className="cursor" />
                  ) : (
                    ""
                  )}
                </pre>
                {screen === "terminal" ? (
                  <div className="quiet-note">
                    <Lock size={18} />
                    <span>
                      You can follow output. Your host must
                      <br />
                      grant full permission to type.
                    </span>
                  </div>
                ) : (
                  <>
                    <div
                      className="keyboard-toolbar"
                      aria-label="Terminal keyboard shortcuts"
                    >
                      {["Esc", "Tab", "Ctrl", "←", "↓", "↑", "→"].map((k) => (
                        <button
                          key={k}
                          aria-label={`Terminal ${k}`}
                          onClick={() =>
                            setNotice(`${k} sent to mock terminal`)
                          }
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                    <input
                      aria-label="Mock terminal input"
                      placeholder="Type a command…"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          setNotice("Mock input only · no command executed");
                          e.currentTarget.value = "";
                        }
                      }}
                    />
                    <p className="footnote">
                      Design preview · input never leaves this page.
                    </p>
                  </>
                )}
              </>
            )}
            {(screen === "browser" || screen === "browser-control") && (
              <>
                <h2 className="compact-title">Browser</h2>
                <p className="intro">The browser on {host}</p>
                <div className="browser-address">
                  <Lock size={14} /> localhost:5173{" "}
                  <span className="badge">Host stream</span>
                </div>
                <button
                  className={`browser-preview ${screen === "browser-control" ? "controlling" : ""}`}
                  aria-label={
                    screen === "browser-control"
                      ? "Tap host browser screenshot to simulate a click"
                      : "Host browser screenshot, view only"
                  }
                  onClick={() => {
                    if (screen === "browser-control")
                      setNotice("Mock tap sent at preview coordinates");
                    else
                      setNotice("Take control to interact with this preview.");
                  }}
                >
                  <img
                    src="/preview.svg"
                    alt="Simulated screenshot of the host browser showing Apex Deck"
                  />
                </button>
                <div className="stream-caption">
                  <i className="dot mint" /> Screenshot stream · mock frame
                </div>
                <div className="group padded">
                  <div className="eyebrow mint">
                    {screen === "browser-control"
                      ? "YOU HAVE CONTROL"
                      : "FOLLOW THE HOST"}
                  </div>
                  <h3>
                    {screen === "browser-control"
                      ? "Tap to click"
                      : "See what your agents see"}
                  </h3>
                  <p className="muted">
                    {screen === "browser-control"
                      ? "Your taps map to the host’s browser. Give control back when you’re done."
                      : "Control requires full access from your host. This button previews that grant. The host can reclaim control at any time."}
                  </p>
                  {button(
                    screen === "browser-control"
                      ? "Give control back"
                      : "Take control",
                    () =>
                      go(
                        screen === "browser-control"
                          ? "browser"
                          : "browser-control",
                      ),
                    screen === "browser-control" ? "wide" : "primary wide",
                  )}
                </div>
              </>
            )}
            {screen === "settings" && (
              <>
                <h2>Device settings</h2>
                <div className="device">
                  <span className="host-icon">
                    <Laptop size={27} />
                  </span>
                  <div>
                    <h3>Tyler’s iPhone</h3>
                    <p className="muted">This device · paired today</p>
                  </div>
                </div>
                <div className="section-label">
                  ACCESS ON {host.toUpperCase()}
                </div>
                <div className="group padded">
                  <div className="permission">
                    <ShieldCheck size={22} />
                    <strong>Chat + approvals</strong>
                    <span className="badge">Host granted</span>
                  </div>
                  <p className="muted">
                    Send messages and review tool requests.
                    <br />
                    Terminal output is read-only.
                  </p>
                  {button(
                    "Compare permission levels",
                    () => setSheet("permissions"),
                    "plain wide",
                  )}
                </div>
                <div className="section-label">PREFERENCES</div>
                <div className="group">
                  {row(
                    Bell,
                    "Approval notifications",
                    notifications ? "On · requests that need you" : "Off",
                    () => setNotifications(!notifications),
                    notifications ? "On" : "Off",
                  )}
                  {row(
                    light ? Sun : Moon,
                    "Appearance",
                    light ? "Light" : "Dark",
                    () => setLight(!light),
                  )}
                </div>
                <p className="footnote">
                  Permission changes happen on the host.
                  <br />
                  This device cannot promote its own access.
                </p>
                {button(
                  "Unpair from this host",
                  () => setSheet("unpair"),
                  "danger wide",
                )}
              </>
            )}
            {[
              "connecting",
              "reconnecting",
              "offline",
              "denied",
              "expired",
            ].includes(screen) && (
              <div className="state-screen">
                <div
                  className={`state-icon ${screen === "denied" || screen === "expired" ? "amber" : ""}`}
                >
                  {screen === "offline" ? (
                    <Monitor size={38} />
                  ) : screen === "denied" ? (
                    <Lock size={38} />
                  ) : screen === "expired" ? (
                    <QrCode size={38} />
                  ) : (
                    <RefreshCw size={38} />
                  )}
                </div>
                <div className="eyebrow">
                  {screen === "expired" ? "DEVICE PAIRING" : host.toUpperCase()}
                </div>
                <h2>
                  {
                    {
                      connecting: "Connecting to Deck",
                      reconnecting: "Picking up the thread",
                      offline: "Your host is offline",
                      denied: "More access needed",
                      expired: "This code has expired",
                    }[
                      screen as
                        | "connecting"
                        | "reconnecting"
                        | "offline"
                        | "denied"
                        | "expired"
                    ]
                  }
                </h2>
                <p className="intro">
                  {
                    {
                      connecting:
                        "Establishing a secure connection. Your agents keep working on the host.",
                      reconnecting:
                        "Reconnected. Catching up on 24 missed events before live updates resume.",
                      offline:
                        "Last seen yesterday at 8:42 PM. Wake your host or check its connection.",
                      denied:
                        "This device has chat + approvals access. Terminal input requires full permission from your host.",
                      expired:
                        "Pairing codes are valid for 5 minutes and can be used only once. Create a fresh code on your host.",
                    }[
                      screen as
                        | "connecting"
                        | "reconnecting"
                        | "offline"
                        | "denied"
                        | "expired"
                    ]
                  }
                </p>
                {screen === "reconnecting" && (
                  <>
                    <div className="progress">
                      <span />
                    </div>
                    <p className="footnote">
                      Syncing 18 of 24 events · mock replay
                    </p>
                  </>
                )}
                <div className="state-actions">
                  {button(
                    screen === "expired"
                      ? "Scan a new code"
                      : screen === "denied"
                        ? "View device permissions"
                        : screen === "offline"
                          ? "Try again"
                          : "Simulate connection complete",
                    () =>
                      go(
                        screen === "expired"
                          ? "qr"
                          : screen === "denied"
                            ? "settings"
                            : screen === "offline"
                              ? "connecting"
                              : "chat",
                      ),
                    "primary wide",
                  )}
                  {button(
                    screen === "connecting" ? "Cancel" : "Back to hosts",
                    () => go("hosts"),
                    "plain wide",
                  )}
                </div>
              </div>
            )}
          </main>
          {screen === "chat" && (
            <div className="composer" inert={!!sheet}>
              <button className="approval-strip" onClick={() => go("approval")}>
                <ShieldCheck size={20} />
                <span>
                  <strong>Codex needs your approval</strong>
                  <small>Edit Navigation.tsx · 1 file</small>
                </span>
                <ChevronRight size={18} />
              </button>
              {attachment && (
                <div className="attached-chip">
                  navigation-sketch.png
                  <button
                    aria-label="Remove attachment"
                    onClick={() => setAttachment(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              <div className="compose-input">
                <textarea
                  aria-label="Message the room"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Message the room…"
                  rows={1}
                />
                <button
                  className="send"
                  aria-label="Send mock message"
                  disabled={!draft.trim()}
                  onClick={() => {
                    setMessages([
                      ...messages,
                      draft + (attachment ? " [navigation-sketch.png]" : ""),
                    ]);
                    setDraft("");
                    setAttachment(false);
                    setNotice("Mock message added to the shared conversation");
                    setTimeout(
                      () =>
                        main.current?.scrollTo(0, main.current.scrollHeight),
                      50,
                    );
                  }}
                >
                  <ArrowUp size={21} />
                </button>
              </div>
              <div className="composer-tools">
                <button
                  aria-label="Attach a mock image"
                  onClick={() => setSheet("attach")}
                >
                  <Paperclip size={20} />
                </button>
                <button
                  aria-label="Mention a participant"
                  onClick={() => setSheet("mentions")}
                >
                  <AtSign size={20} />
                </button>
                <span>All participants can see your message</span>
              </div>
            </div>
          )}
          {threadNav && (
            <nav
              inert={!!sheet}
              className="bottom-tabs"
              aria-label="Thread tools"
            >
              {[
                [MessageSquare, "Chat", "chat"],
                [Terminal, "Terminal", "terminal"],
                [Globe, "Browser", "browser"],
              ].map(([Icon, label, id]) => {
                const I = Icon as typeof Monitor;
                const active =
                  screen === id ||
                  screen === `${id}-full` ||
                  screen === `${id}-control`;
                return (
                  <button
                    key={id as string}
                    className={active ? "active" : ""}
                    aria-current={active ? "page" : undefined}
                    onClick={() => go(id as Screen)}
                  >
                    <I size={21} />
                    <span>{label as string}</span>
                  </button>
                );
              })}
            </nav>
          )}
          {notice && (
            <div className="toast" role="status">
              <span>{notice}</span>
              <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
                <X size={17} />
              </button>
            </div>
          )}
          {sheet && (
            <div className="sheet-overlay" onClick={() => setSheet("")}>
              <div
                ref={sheetRef}
                className="sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="sheet-title"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sheet-handle" />
                <div className="title-row">
                  <h3 id="sheet-title">
                    {
                      {
                        keys: "SSH keys",
                        workspaces: "Choose workspace",
                        agents: "In this room",
                        mentions: "Mention a participant",
                        attach: "Attach to message",
                        image: "Navigation sketch",
                        permissions: "Device permissions",
                        unpair: "Unpair this device?",
                        always: "Always allow this edit?",
                        "always-command": "Always allow this command?",
                      }[sheet]
                    }
                  </h3>
                  <button
                    className="icon-button"
                    aria-label="Close sheet"
                    onClick={() => setSheet("")}
                  >
                    <X size={20} />
                  </button>
                </div>
                {sheet === "keys" &&
                  row(
                    KeyRound,
                    "id_ed25519",
                    "Mock key · not read from your device",
                    () => {
                      setKey("id_ed25519 (mock)");
                      setSheet("");
                    },
                  )}
                {sheet === "workspaces" &&
                  ["Apex Deck", "StreamPortal", "Doctor Doobie"].map((w) =>
                    row(
                      Folder,
                      w,
                      w === "Apex Deck" ? "Active workspace" : "Mock workspace",
                      () => {
                        setSheet("");
                        setNotice(`${w} selected · sample thread list`);
                      },
                    ),
                  )}
                {(sheet === "agents" || sheet === "mentions") &&
                  ["Codex", "Claude", "Everyone"].map((a, i) =>
                    row(
                      i === 2 ? MessageSquare : Command,
                      a,
                      i === 0
                        ? "GPT · high reasoning · host managed"
                        : i === 1
                          ? "Sonnet · design partner"
                          : "Shared transcript · reply when mentioned",
                      () => {
                        if (sheet === "mentions")
                          setDraft(draft + `@${a.toLowerCase()} `);
                        else setNotice(`${a} · host-managed participant`);
                        setSheet("");
                      },
                    ),
                  )}
                {sheet === "attach" &&
                  row(
                    Image,
                    "Navigation sketch",
                    "Add sample image · no file access",
                    () => {
                      setAttachment(true);
                      setSheet("");
                    },
                  )}
                {sheet === "image" && (
                  <img
                    className="sheet-image"
                    src="/preview.svg"
                    alt="Expanded navigation sketch"
                  />
                )}
                {sheet === "permissions" && (
                  <>
                    {row(
                      Eye,
                      "Read-only",
                      "View threads, output, and previews",
                      () => {
                        setSheet("");
                        go("denied");
                      },
                    )}
                    {row(
                      ShieldCheck,
                      "Chat + approvals",
                      "Message agents and decide requests",
                      () => setSheet(""),
                      "Current",
                    )}
                    {row(
                      Terminal,
                      "Full",
                      "Also interact with terminals and files",
                      () => {
                        setSheet("");
                        go("terminal-full");
                      },
                      "Preview",
                    )}
                    <p className="footnote">
                      Only your host can grant a different level.
                      <br />
                      Full is a preview here, not a permission change.
                    </p>
                  </>
                )}
                {sheet === "unpair" && (
                  <>
                    <p>
                      Remove this phone’s pairing with {host}. Work on the host
                      continues.
                    </p>
                    {button(
                      "Unpair device",
                      () => {
                        setUnpaired(true);
                        setSheet("");
                        go("hosts");
                        setNotice("Mock pairing removed");
                      },
                      "danger wide",
                    )}
                    {button("Keep pairing", () => setSheet(""), "plain wide")}
                  </>
                )}
                {sheet.startsWith("always") && (
                  <>
                    <p>
                      Codex may{" "}
                      {sheet === "always"
                        ? "edit src/mobile/Navigation.tsx"
                        : "run npm test"}{" "}
                      again in <strong>this thread on {host}</strong> without
                      asking.
                    </p>
                    <p className="muted">
                      Other files, commands, agents, and hosts still require
                      approval.
                    </p>
                    {button(
                      "Confirm always allow",
                      () => {
                        setDecision("Always allowed for this scope");
                        setSheet("");
                      },
                      "primary wide",
                    )}
                    {button("Cancel", () => setSheet(""), "plain wide")}
                  </>
                )}
              </div>
            </div>
          )}
          <div className="home-safe" aria-hidden="true">
            <div />
          </div>
        </div>
        <div className="stage-footer">
          <span>{screens.find(([id]) => id === screen)?.[1]}</span>
          <span>PROTOTYPE · LOCAL STATE ONLY</span>
        </div>
      </div>
      <aside className="design-caption">
        <span className="eyebrow">THE DESIGN INTENT</span>
        <h3>
          A room, not
          <br />a remote desktop.
        </h3>
        <p>
          The host stays visible. Agent identity stays explicit. Tools come to
          your thumb.
        </p>
        <div className="caption-line" />
        <span className="eyebrow">REVIEW THE FLOW</span>
        <p>
          Start with Your hosts, open a workspace, then enter the shared
          conversation.
        </p>
        <a href="#welcome">
          Try pairing <ArrowRight size={15} />
        </a>
        <a href="#approval">
          Review an approval <ArrowRight size={15} />
        </a>
        <p className="caption-small">
          Use the index to jump to every screen and state. Appearance and type
          controls apply to the whole prototype.
        </p>
      </aside>
    </div>
  );
}
// Native handoff: selection haptic on tool switch; success haptic on pairing;
// warning haptic for approvals; never vibrate on incoming streaming tokens.
createRoot(document.getElementById("root")!).render(<App />);

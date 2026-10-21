import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  AtSign,
  Check,
  ChevronRight,
  KeyRound,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Plus,
  QrCode,
  RefreshCw,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";

export type LocalChatMessage = {
  id: string;
  role: "user" | "assistant";
  agent?: string;
  modelId?: string;
  modelLabel?: string;
  content: string;
  time: string;
  streaming?: boolean;
};

export type LocalChatSession = {
  id: string;
  title: string;
  bots: string[];
  preferredModels?: Record<string, string>;
  messages: LocalChatMessage[];
  updatedAt: string;
  pinned?: boolean;
};

// Keep canonical storage key and /v1 gateway wire protocol unchanged.
// Note: In the production iOS app, transcripts move to SwiftData/SQLite and the
// `apx_sk_...` secret moves to iOS Keychain (`kSecClassGenericPassword`).
// In this browser-based Vite prototype, both are persisted in localStorage.
export const HIST_KEY = "apex-deck.ios.thread-history.v1";
export const GATEWAY_CONFIG_KEY = "apex-deck.ios.gateway-config.v1";

export type GatewayConnectionConfig = {
  baseUrl: string;
  apiKey: string;
  hostLabel: string;
  keySuffix: string;
};

export type LocalChatState =
  | "live"
  | "preview"
  | "no-models"
  | "revoked"
  | "capped"
  | "tool-refused"
  | "offline";

export type LocalChatSessionUpdater =
  | LocalChatSession
  | ((prev: LocalChatSession) => LocalChatSession);

export function normalizeGatewayBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export const DEFAULT_GATEWAY_MODELS = [
  "codex/gpt-6.1-sol",
  "codex/gpt-6-astra",
  "claude/claude-opus-4-6",
  "claude/claude-sonnet-4-6",
  "gemini/gemini-2.5-pro",
  "grok/grok-4.7",
  "grok/grok-4.7-build-fast",
  "grok/grok-4.6",
  "muse/muse-wonder-1.0",
  "openrouter/deepseek/deepseek-r1",
];

type BotDescriptor = {
  name: string;
  prefix: string;
  fallbackRoute: string;
  shortLabel: string;
  cls: string;
  mark: string;
};

const BOT_CATALOG: Record<string, BotDescriptor> = {
  Codex: {
    name: "Codex",
    prefix: "codex/",
    fallbackRoute: "codex/gpt-6.1-sol",
    shortLabel: "GPT-6.1",
    cls: "codex",
    mark: "C",
  },
  Claude: {
    name: "Claude",
    prefix: "claude/",
    fallbackRoute: "claude/claude-opus-4-6",
    shortLabel: "Opus 4.6",
    cls: "claude",
    mark: "✳",
  },
  Gemini: {
    name: "Gemini",
    prefix: "gemini/",
    fallbackRoute: "gemini/gemini-2.5-pro",
    shortLabel: "2.5 Pro",
    cls: "codex",
    mark: "G",
  },
  Grok: {
    name: "Grok",
    prefix: "grok/",
    fallbackRoute: "grok/grok-4.7",
    shortLabel: "4.7",
    cls: "claude",
    mark: "X",
  },
  Muse: {
    name: "Muse",
    prefix: "muse/",
    fallbackRoute: "muse/muse-wonder-1.0",
    shortLabel: "Wonder 1.0",
    cls: "codex",
    mark: "M",
  },
};

export const DEFAULT_LOCAL_SESSIONS: LocalChatSession[] = [
  {
    id: "lc-1",
    title: "Weekend architecture",
    bots: ["Codex", "Claude", "Grok"],
    preferredModels: {
      Codex: "codex/gpt-6.1-sol",
      Claude: "claude/claude-opus-4-6",
      Grok: "grok/grok-4.7",
    },
    updatedAt: "now",
    pinned: true,
    messages: [
      {
        id: "m-1",
        role: "user",
        content: "@codex What is 17 × 23?",
        time: "9:39 AM",
      },
      {
        id: "m-2",
        role: "assistant",
        agent: "Codex",
        modelId: "codex/gpt-6.1-sol",
        modelLabel: "gpt-6.1-sol",
        content: "17 multiplied by 23 is 391, calculated as (17 × 20) + (17 × 3) = 340 + 51.",
        time: "9:39 AM",
      },
      {
        id: "m-3",
        role: "user",
        content: "@claude Why keep this session in Local chat instead of a paired machine thread?",
        time: "9:40 AM",
      },
      {
        id: "m-4",
        role: "assistant",
        agent: "Claude",
        modelId: "claude/claude-opus-4-6",
        modelLabel: "claude-opus-4-6",
        content:
          "Local chat stores the transcript on this phone and only streams stateless /v1/chat/completions turns from your host—so your private MCP tools stay off-limits and zero setup sits in the thread.",
        time: "9:40 AM",
      },
    ],
  },
];

export function loadLocalChatSessions(): LocalChatSession[] {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    if (!raw) return structuredClone(DEFAULT_LOCAL_SESSIONS);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Ignore storage read errors in restricted contexts
  }
  return structuredClone(DEFAULT_LOCAL_SESSIONS);
}

export function saveLocalChatSessions(sessions: LocalChatSession[]): void {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(sessions));
  } catch {
    // Ignore quota / private browsing errors in mock
  }
}

export function loadGatewayConfig(): GatewayConnectionConfig {
  try {
    const raw = localStorage.getItem(GATEWAY_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.baseUrl === "string") return parsed;
    }
  } catch {
    // Ignore storage errors
  }
  return {
    baseUrl: "",
    apiKey: "",
    hostLabel: "Tyler’s MacBook",
    keySuffix: "…09b",
  };
}

export function saveGatewayConfig(cfg: GatewayConnectionConfig): void {
  try {
    localStorage.setItem(GATEWAY_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // Ignore storage errors
  }
}

export function parseGatewayPairingLink(input: string): Partial<GatewayConnectionConfig> | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("apexdeck://gateway")) {
    try {
      const url = new URL(trimmed.replace(/^apexdeck:\/\//, "http://"));
      const baseUrl = normalizeGatewayBaseUrl(url.searchParams.get("url") || "");
      const apiKey = url.searchParams.get("key") || "";
      const hostLabel = url.searchParams.get("host") || "Tyler’s MacBook";
      const keySuffix = apiKey.length >= 4 ? `…${apiKey.slice(-3)}` : "…09b";
      return { baseUrl, apiKey, hostLabel, keySuffix };
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { baseUrl: normalizeGatewayBaseUrl(trimmed) };
  }
  if (trimmed.startsWith("apx_sk_")) {
    return {
      apiKey: trimmed,
      keySuffix: `…${trimmed.slice(-3)}`,
    };
  }
  return null;
}

export function resolveBotAndModel(
  text: string,
  session: LocalChatSession,
  availableModels: string[],
): { bot: string; modelId: string; modelLabel: string } {
  const catalogModels =
    availableModels.length > 0 ? availableModels : DEFAULT_GATEWAY_MODELS;
  const match = text.match(/@(codex|claude|gemini|grok|muse)\b/i);
  const requestedBot = match
    ? Object.keys(BOT_CATALOG).find(
        (k) => k.toLowerCase() === match[1].toLowerCase(),
      ) || session.bots[0] || "Codex"
    : session.bots[0] || "Codex";

  const descriptor = BOT_CATALOG[requestedBot] || BOT_CATALOG.Codex;
  const preferred = session.preferredModels?.[descriptor.name];
  const matchingForFamily = catalogModels.filter((m) =>
    m.toLowerCase().startsWith(descriptor.prefix),
  );

  let modelId = descriptor.fallbackRoute;
  if (preferred && catalogModels.includes(preferred)) {
    modelId = preferred;
  } else if (matchingForFamily.length > 0) {
    modelId = matchingForFamily[0];
  } else if (catalogModels.length > 0) {
    modelId = catalogModels[0];
  }

  const slashIdx = modelId.indexOf("/");
  const modelLabel = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;
  return { bot: descriptor.name, modelId, modelLabel };
}

async function* readSseDeltas(
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              yield delta;
            }
          } catch {
            // Ignore partial JSON frames
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function LocalChatThread({
  config,
  session,
  onUpdateSession,
  onOpenSettings,
  onBack,
  onNavigateTab,
}: {
  config: GatewayConnectionConfig;
  session: LocalChatSession;
  onUpdateSession: (updater: LocalChatSessionUpdater) => void;
  onOpenSettings: () => void;
  onBack: () => void;
  onNavigateTab: (route: string) => void;
}) {
  const isPaired = Boolean(config.baseUrl.trim() && config.apiKey.trim());
  const activeState = (): LocalChatState => (isPaired ? "live" : "preview");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<LocalChatState>(() => activeState());
  const [statusDetail, setStatusDetail] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>(
    DEFAULT_GATEWAY_MODELS,
  );
  const [sheet, setSheet] = useState<"" | "status" | "participants">("");
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const clearPendingStreams = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    return () => clearPendingStreams();
  }, []);

  const probeModels = async () => {
    if (!config.baseUrl || !config.apiKey) {
      setAvailableModels(DEFAULT_GATEWAY_MODELS);
      setStatus("preview");
      setStatusDetail("");
      return;
    }
    const normalizedBase = normalizeGatewayBaseUrl(config.baseUrl);
    try {
      const res = await fetch(`${normalizedBase}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        setStatus("revoked");
        setStatusDetail("This key was revoked or rotated on the host.");
        return;
      }
      if (res.status === 429) {
        setStatus("capped");
        setStatusDetail("Daily request or monthly spend limit reached.");
        return;
      }
      if (res.status === 409) {
        setStatus("tool-refused");
        setStatusDetail("Host refused private MCP tool execution for this key.");
        return;
      }
      if (!res.ok) {
        setStatus("offline");
        setStatusDetail(`Host returned HTTP ${res.status}.`);
        return;
      }
      const body = await res.json();
      const ids = Array.isArray(body?.data)
        ? body.data
            .map((item: { id?: string }) => item?.id)
            .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
        : [];
      if (ids.length === 0) {
        setAvailableModels([]);
        setStatus("no-models");
        setStatusDetail("The host answered, but this key can see no models.");
        return;
      }
      setAvailableModels(ids);
      setStatus("live");
      setStatusDetail("");
    } catch {
      setStatus("offline");
      setStatusDetail("Could not reach the host /v1 endpoint.");
    }
  };

  useEffect(() => {
    void probeModels();
  }, [config.baseUrl, config.apiKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [session.messages.length]);

  useEffect(() => {
    if (!sheet) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet("");
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [sheet]);

  const canSend = status === "live" || status === "preview";

  async function send() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");

    const { bot, modelId, modelLabel } = resolveBotAndModel(
      text,
      session,
      availableModels,
    );
    const now = new Date().toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

    const userMsg: LocalChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      time: now,
    };
    const replyId = `a-${Date.now() + 1}`;
    const placeholderMsg: LocalChatMessage = {
      id: replyId,
      role: "assistant",
      agent: bot,
      modelId,
      modelLabel,
      content: "",
      time: now,
      streaming: true,
    };

    const derivedTitle =
      text
        .replace(/@\S+/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 5)
        .join(" ") || "Local chat";

    onUpdateSession((prev) => ({
      ...prev,
      title: prev.title === "New local chat" ? derivedTitle : prev.title,
      messages: [...prev.messages, userMsg, placeholderMsg],
      updatedAt: "now",
    }));

    if (!config.baseUrl || !config.apiKey) {
      if (timerRef.current) clearInterval(timerRef.current);
      const sample = `Preview reply from ${bot} (${modelLabel}). Connect your host in Settings → Local chat to stream live /v1 turns while keeping this transcript stored on this iPhone.`;
      let idx = 0;
      timerRef.current = setInterval(() => {
        idx += 8;
        const slice = sample.slice(0, idx);
        const done = idx >= sample.length;
        if (done && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        onUpdateSession((prev) => ({
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === replyId ? { ...m, content: slice, streaming: !done } : m,
          ),
          updatedAt: "now",
        }));
      }, 40);
      return;
    }

    clearPendingStreams();
    const ac = new AbortController();
    abortRef.current = ac;
    const normalizedBase = normalizeGatewayBaseUrl(config.baseUrl);

    try {
      const res = await fetch(`${normalizedBase}/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          stream: true,
          messages: [...session.messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) {
        let errMsg = "";
        try {
          const errJson = await res.json();
          errMsg = errJson?.error?.message || "";
        } catch {
          // Ignore non-JSON error body
        }
        if (res.status === 401) {
          setStatus("revoked");
          setStatusDetail(
            errMsg || "This API key has been revoked on the host.",
          );
        } else if (res.status === 429) {
          setStatus("capped");
          setStatusDetail(
            errMsg || "Daily request cap or monthly spend limit reached.",
          );
        } else if (res.status === 409 || res.status === 502) {
          setStatus("tool-refused");
          setStatusDetail(
            errMsg || "Private host MCP tools are disabled for gateway clients.",
          );
        } else {
          setStatus("offline");
          setStatusDetail(errMsg || `Host returned HTTP ${res.status}.`);
        }
        onUpdateSession((prev) => ({
          ...prev,
          messages: prev.messages.filter((m) => m.id !== replyId),
        }));
        return;
      }

      let acc = "";
      for await (const delta of readSseDeltas(res, ac.signal)) {
        acc += delta;
        const snapshot = acc;
        onUpdateSession((prev) => ({
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === replyId ? { ...m, content: snapshot, streaming: true } : m,
          ),
        }));
      }

      onUpdateSession((prev) => ({
        ...prev,
        messages: prev.messages.map((m) =>
          m.id === replyId ? { ...m, content: acc, streaming: false } : m,
        ),
      }));
    } catch {
      if (!ac.signal.aborted) {
        setStatus("offline");
        setStatusDetail("Connection lost before stream completed.");
        onUpdateSession((prev) => ({
          ...prev,
          messages: prev.messages.filter((m) => m.id !== replyId),
        }));
      }
    }
  }

  const pillLabel =
    status === "live"
      ? "● Local chat"
      : status === "preview"
        ? "● Local chat (preview)"
        : status === "no-models"
          ? "○ No models for this key"
          : status === "revoked"
            ? "○ Local chat paused — reconnect"
            : status === "capped"
              ? "○ Daily limit reached"
              : status === "tool-refused"
                ? "○ Private tool blocked"
                : "○ Host offline";

  const pillDotColor =
    status === "live" || status === "preview"
      ? "var(--mint)"
      : status === "no-models" ||
          status === "revoked" ||
          status === "capped" ||
          status === "tool-refused"
        ? "var(--amber)"
        : "var(--red)";

  return (
    <>
      <header className="phone-header" inert={!!sheet}>
        <button className="back" onClick={onBack}>
          <ArrowLeft size={20} />
          <span>Threads</span>
        </button>
        <button
          className="connection"
          onClick={() => setSheet("status")}
          aria-label="Local chat status"
        >
          <i style={{ background: pillDotColor }} />
          {pillLabel}
        </button>
      </header>

      <div className="mf-chat-header" inert={!!sheet}>
        <div className="chat-context">
          <span>On this iPhone · Local chat session</span>
        </div>
        <div className="chat-heading">
          <h2>{session.title}</h2>
          <button
            className="icon-button"
            aria-label="Local chat details"
            onClick={() => setSheet("status")}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
        <p className="mf-path mf-header-path">
          {config.hostLabel} models · Key {config.keySuffix}
        </p>
      </div>

      <main
        ref={scrollRef}
        className="phone-content mf-content chat-content"
        inert={!!sheet}
      >
        <button
          className="participants"
          onClick={() => setSheet("participants")}
        >
          <span className="avatar codex">C</span>
          <span className="avatar claude">✳</span>
          <span>
            {session.bots.join(" · ")}
            <small> · on-device session</small>
            <br />
            <small>Tap to mention or switch model · history stays on iPhone</small>
          </span>
          <ChevronRight size={16} />
        </button>

        {!canSend && (
          <div className="mf-banner" role="status">
            <strong>
              {status === "no-models"
                ? "This key sees no models"
                : status === "revoked"
                  ? "Local chat paused — reconnect"
                  : status === "capped"
                    ? "Daily limit reached on this key"
                    : status === "tool-refused"
                      ? "Private host MCP tool blocked"
                      : "Host offline"}
            </strong>
            <p>
              {statusDetail ||
                (status === "no-models"
                  ? "The host answered, but this key can see no models."
                  : status === "revoked"
                    ? "Your access key was paused or revoked on the host. Your local chat history on this iPhone is untouched."
                    : status === "capped"
                      ? "This key hit its daily turn or monthly spend cap. Your transcript stays readable on this phone."
                      : status === "tool-refused"
                        ? "Private host MCP servers (x_mcp, hl_mcp) are never exposed to gateway keys."
                        : "Can’t reach the host right now. Previous messages remain available on this phone.")}
            </p>
            <button
              className="wide"
              onClick={() => {
                setStatus(activeState());
                setStatusDetail("");
                void probeModels();
              }}
            >
              Retry connection
            </button>
            <button className="wide plain" onClick={onOpenSettings}>
              Open Settings → Local chat
            </button>
          </div>
        )}

        <div className="date-label">STORED ON THIS IPHONE</div>

        {session.messages.map((m) => {
          const botInfo = BOT_CATALOG[m.agent || "Codex"] || BOT_CATALOG.Codex;
          return m.role === "user" ? (
            <article className="message human" key={m.id}>
              <div className="message-by">
                You <time>{m.time}</time>
              </div>
              <p>{m.content}</p>
            </article>
          ) : (
            <article className="message" key={m.id}>
              <div className="message-by">
                <span className={`avatar ${botInfo.cls}`}>{botInfo.mark}</span>
                {m.agent || "Codex"}{" "}
                <span className="model-label">
                  {m.modelLabel || botInfo.shortLabel}
                </span>
                {m.streaming ? (
                  <span className="stream-label">● Writing</span>
                ) : (
                  <time>{m.time}</time>
                )}
              </div>
              <p>
                {m.content}
                {m.streaming && <span className="cursor" />}
              </p>
            </article>
          );
        })}
      </main>

      <div className="composer mf-composer" inert={!!sheet}>
        <div className="compose-input">
          <textarea
            aria-label="Message local chat"
            rows={2}
            value={draft}
            disabled={!canSend}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              canSend
                ? "Message @codex, @claude, @grok…"
                : "Paused — retry or open Settings → Local chat"
            }
          />
          <button
            className="send"
            aria-label="Send local chat message"
            disabled={!canSend || !draft.trim()}
            onClick={() => void send()}
          >
            <ArrowUp size={21} />
          </button>
        </div>
        <div className="composer-tools">
          <button
            aria-label="Mention a participant"
            onClick={() => setSheet("participants")}
          >
            <AtSign size={20} />
          </button>
          <span>Stored on this iPhone · {config.hostLabel} models</span>
        </div>
      </div>

      <nav
        className="bottom-tabs"
        aria-label="Workspace sections"
        inert={!!sheet}
      >
        {[
          ["Agents", "agents"],
          ["Code", "code"],
          ["Threads", "threads"],
          ["Library", "library"],
        ].map(([label, route]) => (
          <button
            key={route}
            className={route === "threads" ? "active" : ""}
            onClick={() =>
              route === "threads" ? onBack() : onNavigateTab(route)
            }
          >
            <MessageSquare size={21} />
            {label}
          </button>
        ))}
      </nav>

      {sheet && (
        <div className="sheet-overlay" onClick={() => setSheet("")}>
          <div
            className="sheet mf-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lc-sheet-title"
            ref={dialogRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="title-row">
              <h3 id="lc-sheet-title">
                {sheet === "status"
                  ? "Local chat session"
                  : "Participants & models"}
              </h3>
              <button
                className="icon-button"
                aria-label="Close sheet"
                onClick={() => setSheet("")}
              >
                <X size={20} />
              </button>
            </div>

            {sheet === "status" && (
              <>
                <p>
                  Messages in <strong>{session.title}</strong> are saved on this
                  iPhone. Replies stream from <strong>{config.hostLabel}</strong>{" "}
                  using key <code>{config.keySuffix}</code>.
                </p>
                <p className="scope">
                  Available models ({availableModels.length}):{" "}
                  {availableModels.slice(0, 5).join(", ")}
                  {availableModels.length > 5 ? "…" : ""}
                </p>
                <p className="scope">
                  Private host MCP tools (<code>x_mcp</code>, <code>hl_mcp</code>)
                  are permanently excluded. The host owner can pause or revoke
                  this key at any time.
                </p>
                <button
                  className="wide"
                  onClick={() => {
                    setStatus(activeState());
                    setStatusDetail("");
                    void probeModels();
                    setSheet("");
                  }}
                >
                  Refresh /v1/models
                </button>
                <button
                  className="wide"
                  onClick={() => {
                    setStatus(status === "revoked" ? activeState() : "revoked");
                    setStatusDetail(
                      status === "revoked"
                        ? ""
                        : "Simulated 401: This API key has been revoked.",
                    );
                    setSheet("");
                  }}
                >
                  {status === "revoked"
                    ? "Restore live state"
                    : "Simulate revoked key (401)"}
                </button>
                <button
                  className="wide"
                  onClick={() => {
                    setStatus(status === "capped" ? activeState() : "capped");
                    setStatusDetail(
                      status === "capped"
                        ? ""
                        : "Simulated 429: Daily turn cap reached (100/100).",
                    );
                    setSheet("");
                  }}
                >
                  {status === "capped"
                    ? "Clear daily cap"
                    : "Simulate daily cap (429)"}
                </button>
                <button
                  className="wide plain"
                  onClick={() => {
                    setSheet("");
                    onOpenSettings();
                  }}
                >
                  Settings → Local chat
                </button>
              </>
            )}

            {sheet === "participants" && (
              <>
                <p>
                  Mention an agent to route your next turn, or pick which model
                  from <code>GET /v1/models</code> answers for each family.
                </p>
                {Object.values(BOT_CATALOG).map((bot) => {
                  const familyModels = availableModels.filter((m) =>
                    m.toLowerCase().startsWith(bot.prefix),
                  );
                  const unavailable =
                    status === "no-models" && familyModels.length === 0;
                  const activeRoute = unavailable
                    ? "No models available for this key"
                    : session.preferredModels?.[bot.name] ||
                      familyModels[0] ||
                      bot.fallbackRoute;
                  return (
                    <button
                      key={bot.name}
                      className="row"
                      disabled={unavailable}
                      onClick={() => {
                        const nextIdx =
                          familyModels.length > 1
                            ? (familyModels.indexOf(activeRoute) + 1) %
                              familyModels.length
                            : 0;
                        const nextModel = familyModels[nextIdx] || activeRoute;
                        onUpdateSession((prev) => ({
                          ...prev,
                          bots: prev.bots.includes(bot.name)
                            ? prev.bots
                            : [...prev.bots, bot.name],
                          preferredModels: {
                            ...(prev.preferredModels || {}),
                            [bot.name]: nextModel,
                          },
                        }));
                        setDraft(
                          (prev) =>
                            `@${bot.name.toLowerCase()} ${prev.replace(/^@\w+\s*/, "")}`,
                        );
                        setSheet("");
                      }}
                    >
                      <span className={`avatar ${bot.cls}`}>{bot.mark}</span>
                      <span className="row-copy">
                        <strong>Mention @{bot.name.toLowerCase()}</strong>
                        <small>{activeRoute}</small>
                      </span>
                      {session.bots.includes(bot.name) && <Check size={17} />}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

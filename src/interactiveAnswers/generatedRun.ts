/** Trusted UI lifecycle. Main owns validation, revision digests and execution. */
import type { GeneratedRuntimeCapability } from '../../shared/generatedUiCapability.mjs';
export interface GeneratedIdentity { threadId: string; seq: number; cardId: string; hostId: string }
export interface GeneratedBounds { x: number; y: number; width: number; height: number }
export interface GeneratedColors { background: string; foreground: string; light: boolean }
export interface GeneratedEvent {
  runId: string;
  type: "ready" | "resize" | "discuss" | "stopped" | "snapshot";
  image?: string;
  height?: number;
  text?: string;
  reason?: string;
}
export interface GeneratedApi {
  capability(): Promise<GeneratedRuntimeCapability>;
  run(request: { requestId: string; source: string; identity: GeneratedIdentity; bounds: GeneratedBounds; colors?: GeneratedColors }): Promise<{ runId: string; revisionDigest: string }>;
  cached?(request: { requestId: string; source: string; identity: GeneratedIdentity; bounds: GeneratedBounds }): Promise<{ image: string | null }>;
  /** Revoke a pending start even before run() returns a runId. */
  cancel(requestId: string): Promise<void>;
  bounds(runId: string, bounds: GeneratedBounds | null): void;
  stop(runId: string): Promise<void>;
  onEvent(cb: (event: GeneratedEvent) => void): () => void;
}
export interface GeneratedState {
  enabled: boolean;
  phase: "idle" | "starting" | "running";
  reason: string;
  discuss: string;
  height: number;
  attempted: boolean;
  image?: string;
  cacheChecked?: boolean;
}

function validSnapshot(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value);
}

export function latestCardVersion(versions: Map<string, number>, cardId: string): number {
  let latest = 1;
  for (const [key, version] of versions) if (key.endsWith(`:${cardId}`)) latest = Math.max(latest, version);
  return latest;
}

// Main emits these reasons when the native view loses its presentation surface.
const presentationStops = new Set([
  "Deck window hidden.", "Deck window minimized.", "Deck window lost focus.",
  "The Deck window must be in the foreground.",
  "Deck zoom changed.", "Interface is no longer visible.",
  "The owning Deck frame is no longer in the foreground.",
  "Interface bounds are outside the visible card.",
  "Interface geometry changed during initialization.",
]);

/** Each automatic start requires stable visible bounds and an enabled host. */
export class GeneratedRun {
  state: GeneratedState = { enabled: false, phase: "idle", reason: "Checking interface availability…", discuss: "", height: 300, attempted: false };
  private api: GeneratedApi | undefined;
  private request: { source: string; identity: GeneratedIdentity };
  private changed: () => void;
  private colors?: () => GeneratedColors | undefined;
  private generation = 0;
  private disposed = false;
  private current: string | null = null;
  private snapshotRun: string | null = null;
  private requestId: string | null = null;
  private early: GeneratedEvent[] = [];
  private unsubscribe: (() => void) | undefined;
  private automaticBounds: string | null = null;
  private visibleSince = 0;
  private releasing = false;

  constructor(api: GeneratedApi | undefined, request: { source: string; identity: GeneratedIdentity }, changed: () => void, colors?: () => GeneratedColors | undefined) {
    this.colors = colors;
    this.api = api;
    this.request = request;
    this.changed = changed;
    this.unsubscribe = api?.onEvent((event) => this.receive(event));
  }
  private update(patch: Partial<GeneratedState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.changed();
  }
  async restoreImage() {
    try {
      const cached = await this.api?.cached?.({ ...this.request, requestId: crypto.randomUUID(), bounds: {x:0,y:40,width:100,height:200} });
      if (cached?.image && validSnapshot(cached.image)) this.update({image: cached.image});
    } catch { /* An unavailable image cache never prevents execution. */ }
    finally { this.update({cacheChecked:true}); }
  }
  async checkCapability(preserveReasonWhenEnabled = false) {
    try {
      const result = await this.api?.capability();
      this.update({ enabled: result?.enabled === true, reason: result?.enabled && preserveReasonWhenEnabled ? this.state.reason : result?.reason ?? "Interactive content is unavailable here." });
    } catch {
      this.update({ enabled: false, reason: "Interactive content is unavailable here." });
    }
  }
  async autoStart(bounds: GeneratedBounds | null, now: number) {
    if (this.disposed || this.releasing || this.state.attempted || this.state.phase !== "idle") return;
    if (!bounds || !this.state.enabled || !Number.isFinite(now)) { this.automaticBounds = null; return; }
    const sample = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
    if (sample !== this.automaticBounds) { this.automaticBounds = sample; this.visibleSince = now; return; }
    if (now - this.visibleSince >= 250) await this.start(bounds);
  }
  async start(bounds: GeneratedBounds) {
    if (this.disposed || this.releasing || !this.api || !this.state.enabled || this.state.phase !== "idle") return;
    const generation = ++this.generation;
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.early = [];
    this.update({ phase: "starting", reason: "Opening interface…", discuss: "", attempted: true });
    try {
      const colors = this.colors?.();
      const result = await this.api.run({ ...this.request, requestId, bounds, ...(colors && { colors }) });
      if (this.disposed || generation !== this.generation) {
        await this.api.stop(result.runId).catch(() => {});
        return;
      }
      this.current = result.runId;
      this.snapshotRun = result.runId;
      for (const event of this.early) this.receive(event);
      this.early = [];
    } catch (error) {
      if (generation === this.generation) {
        this.requestId = null;
        // Electron wraps rejected invoke() errors with the channel name.
        const message = error instanceof Error ? error.message.replace(/^Error invoking remote method 'generated-ui:run': Error: /, "") : "";
        const resume = presentationStops.has(message);
        this.automaticBounds = null;
        this.update({ phase: "idle", attempted: !resume, reason: resume ? "" : "This interface could not open.", discuss: "" });
        void this.checkCapability(true);
      }
    }
  }
  private receive(event: GeneratedEvent) {
    if (this.disposed) return;
    // Main may finish its final raster capture after disposal. It carries no
    // execution authority and is accepted only for this mount’s latest run.
    if (event.type === "snapshot" && event.runId === this.snapshotRun && validSnapshot(event.image)) { this.update({image: event.image}); return; }
    if (!this.current && this.state.phase === "starting") {
      if (this.early.length < 10) this.early.push(event);
      return;
    }
    if (event.runId !== this.current) return;
    if (event.type === "snapshot" && validSnapshot(event.image)) this.update({image: event.image});
    else if (event.type === "ready") this.update({ phase: "running", reason: "" });
    else if (event.type === "resize" && typeof event.height === "number" && Number.isFinite(event.height)) this.update({ height: Math.max(200, Math.min(800, event.height)) });
    else if (event.type === "discuss" && typeof event.text === "string" && event.text.length <= 4000) this.update({ discuss: event.text });
    else if (event.type === "stopped") {
      this.current = null;
      this.requestId = null;
      ++this.generation;
      this.automaticBounds = null;
      const resume = presentationStops.has(event.reason ?? "");
      this.update({ phase: "idle", attempted: !resume, reason: resume ? "" : event.reason ?? "Interface stopped.", discuss: "" });
      void this.checkCapability(true);
    }
  }
  place(bounds: GeneratedBounds | null) {
    if (bounds === null) { void this.stop(true); return; }
    if (this.current) this.api?.bounds(this.current, bounds);
  }
  takeDiscuss(): string {
    const text = this.state.discuss;
    this.update({ discuss: "" });
    return text;
  }
  async stop(resumeWhenVisible = false) {
    const generation = ++this.generation;
    this.automaticBounds = null;
    const runId = this.current;
    const requestId = this.requestId;
    this.current = null;
    this.requestId = null;
    this.early = [];
    this.releasing = true;
    this.update({ phase: "idle", reason: "", discuss: "", attempted: !resumeWhenVisible });
    await Promise.allSettled([
      ...(requestId && this.api ? [this.api.cancel(requestId)] : []),
      ...(runId && this.api ? [this.api.stop(runId)] : []),
    ]);
    if (this.disposed || generation !== this.generation) return;
    await this.checkCapability(true);
    if (generation === this.generation) this.releasing = false;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop();
    this.unsubscribe?.();
  }
}

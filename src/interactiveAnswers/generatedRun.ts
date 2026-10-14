/** Trusted UI lifecycle. Main owns validation, revision digests and execution. */
import type { GeneratedRuntimeCapability } from '../../shared/generatedUiCapability.mjs';
export interface GeneratedIdentity { threadId: string; seq: number; cardId: string; hostId: string }
export interface GeneratedBounds { x: number; y: number; width: number; height: number }
export interface GeneratedEvent {
  runId: string;
  type: "ready" | "resize" | "discuss" | "stopped";
  height?: number;
  text?: string;
  reason?: string;
}
export interface GeneratedApi {
  capability(): Promise<GeneratedRuntimeCapability>;
  run(request: { requestId: string; source: string; identity: GeneratedIdentity; bounds: GeneratedBounds }): Promise<{ runId: string; revisionDigest: string }>;
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
}

export function latestCardVersion(versions: Map<string, number>, cardId: string): number {
  let latest = 1;
  for (const [key, version] of versions) if (key.endsWith(`:${cardId}`)) latest = Math.max(latest, version);
  return latest;
}

/** Each instance starts fresh. Automatic opening is a single, visible attempt. */
export class GeneratedRun {
  state: GeneratedState = { enabled: false, phase: "idle", reason: "Checking interface availability…", discuss: "", height: 300, attempted: false };
  private api: GeneratedApi | undefined;
  private request: { source: string; identity: GeneratedIdentity };
  private changed: () => void;
  private generation = 0;
  private disposed = false;
  private current: string | null = null;
  private requestId: string | null = null;
  private early: GeneratedEvent[] = [];
  private unsubscribe: (() => void) | undefined;
  private automaticBounds: string | null = null;
  private visibleSince = 0;

  constructor(api: GeneratedApi | undefined, request: { source: string; identity: GeneratedIdentity }, changed: () => void) {
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
  async checkCapability(preserveReasonWhenEnabled = false) {
    try {
      const result = await this.api?.capability();
      this.update({ enabled: result?.enabled === true, reason: result?.enabled && preserveReasonWhenEnabled ? this.state.reason : result?.reason ?? "This client shows the text version of this interface." });
    } catch {
      this.update({ enabled: false, reason: "This interface is unavailable. The text version is below." });
    }
  }
  async autoStart(bounds: GeneratedBounds | null, now: number) {
    if (this.disposed || this.state.attempted || this.state.phase !== "idle") return;
    if (!bounds || !this.state.enabled || !Number.isFinite(now)) { this.automaticBounds = null; return; }
    const sample = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
    if (sample !== this.automaticBounds) { this.automaticBounds = sample; this.visibleSince = now; return; }
    if (now - this.visibleSince >= 250) await this.start(bounds);
  }
  async start(bounds: GeneratedBounds) {
    if (this.disposed || !this.api || !this.state.enabled || this.state.phase !== "idle") return;
    const generation = ++this.generation;
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.early = [];
    this.update({ phase: "starting", reason: "Opening interface…", discuss: "", attempted: true });
    try {
      const result = await this.api.run({ ...this.request, requestId, bounds });
      if (this.disposed || generation !== this.generation) {
        await this.api.stop(result.runId).catch(() => {});
        return;
      }
      this.current = result.runId;
      for (const event of this.early) this.receive(event);
      this.early = [];
    } catch {
      if (generation === this.generation) {
        this.requestId = null;
        this.update({ phase: "idle", reason: "This interface could not start. You can try again.", discuss: "" });
        void this.checkCapability(true);
      }
    }
  }
  private receive(event: GeneratedEvent) {
    if (this.disposed) return;
    if (!this.current && this.state.phase === "starting") {
      if (this.early.length < 10) this.early.push(event);
      return;
    }
    if (event.runId !== this.current) return;
    if (event.type === "ready") this.update({ phase: "running", reason: "" });
    else if (event.type === "resize" && typeof event.height === "number" && Number.isFinite(event.height)) this.update({ height: Math.max(200, Math.min(800, event.height)) });
    else if (event.type === "discuss" && typeof event.text === "string" && event.text.length <= 4000) this.update({ discuss: event.text });
    else if (event.type === "stopped") {
      this.current = null;
      this.requestId = null;
      ++this.generation;
      this.update({ phase: "idle", reason: event.reason ?? "Interface stopped. Restart to start fresh.", discuss: "" });
      void this.checkCapability(true);
    }
  }
  place(bounds: GeneratedBounds | null) {
    if (bounds === null) { void this.stop(); return; }
    if (this.current) this.api?.bounds(this.current, bounds);
  }
  takeDiscuss(): string {
    const text = this.state.discuss;
    this.update({ discuss: "" });
    return text;
  }
  async stop() {
    ++this.generation;
    const runId = this.current;
    const requestId = this.requestId;
    this.current = null;
    this.requestId = null;
    this.early = [];
    this.update({ phase: "idle", reason: "Interface stopped. Restart to start fresh.", discuss: "", attempted: true });
    await Promise.allSettled([
      ...(requestId && this.api ? [this.api.cancel(requestId)] : []),
      ...(runId && this.api ? [this.api.stop(runId)] : []),
    ]);
    await this.checkCapability(true);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop();
    this.unsubscribe?.();
  }
}

/** Trusted UI lifecycle. Main owns validation, approval digests and execution. */
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
  capability(): Promise<{ enabled: boolean; reason: string }>;
  run(request: { requestId: string; source: string; identity: GeneratedIdentity; bounds: GeneratedBounds }): Promise<{ runId: string; revisionDigest: string }>;
  /** Revoke a click's authority even before run() returns a runId. */
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
}

export function latestCardVersion(versions: Map<string, number>, cardId: string): number {
  let latest = 1;
  for (const [key, version] of versions) if (key.endsWith(`:${cardId}`)) latest = Math.max(latest, version);
  return latest;
}

/** No saved approval; each new instance starts idle and requires a human click. */
export class GeneratedRun {
  state: GeneratedState = { enabled: false, phase: "idle", reason: "Checking interface availability…", discuss: "", height: 300 };
  private api: GeneratedApi | undefined;
  private request: { source: string; identity: GeneratedIdentity };
  private changed: () => void;
  private generation = 0;
  private disposed = false;
  private current: string | null = null;
  private requestId: string | null = null;
  private early: GeneratedEvent[] = [];
  private unsubscribe: (() => void) | undefined;

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
  async checkCapability() {
    try {
      const result = await this.api?.capability();
      this.update({ enabled: result?.enabled === true, reason: result?.reason ?? "This client shows the text version of this interface." });
    } catch {
      this.update({ enabled: false, reason: "This interface is unavailable. The text version is below." });
    }
  }
  async start(bounds: GeneratedBounds) {
    if (this.disposed || !this.api || !this.state.enabled || this.state.phase !== "idle") return;
    const generation = ++this.generation;
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.early = [];
    this.update({ phase: "starting", reason: "Starting interface…", discuss: "" });
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
      this.update({ phase: "idle", reason: event.reason ?? "Interface stopped. Run it again to start fresh.", discuss: "" });
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
    this.update({ phase: "idle", reason: "Interface stopped. Run it again to start fresh.", discuss: "" });
    await Promise.allSettled([
      ...(requestId && this.api ? [this.api.cancel(requestId)] : []),
      ...(runId && this.api ? [this.api.stop(runId)] : []),
    ]);
  }
  dispose() {
    if (this.disposed) return;
    void this.stop();
    this.disposed = true;
    this.unsubscribe?.();
  }
}

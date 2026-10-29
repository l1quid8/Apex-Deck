export const SCHEMA_VERSION = 1 as const;

export type RunnerKind = 'goal' | 'loop';
export type RunnerPhase = 'running' | 'scheduled' | 'waiting' | 'paused' | 'completed' | 'ended';
export type RunnerReason =
  | 'human'
  | 'approval'
  | 'question'
  | 'blocked'
  | 'stuck'
  | 'limit'
  | 'provider_usage'
  | 'provider_error'
  | 'recovery'
  | 'configuration'
  | 'storage'
  | 'completed'
  | 'none';

export interface RunnerLimits {
  schemaVersion: number;
  maxTurns?: number; // goal turns or loop runs
  maxInvocations?: number;
  lifetimeMs: number;
  maxCostMicros?: number | null;
}

export interface RunnerUsage {
  turns: number;
  invocations: number;
  costMicros: number | null;
  unknownCostTurns: number;
  elapsedMs: number;
}

export interface RunnerCheckpoint {
  done: string;
  next: string;
  blocker: string | null;
  criteria: { id: string; status: 'pending' | 'done' | 'failed'; evidence: string[] }[];
}

export interface RunnerSnapshot {
  schemaVersion: number;
  id: string;
  roomId: string;
  revision: number;
  generation: number;
  kind: RunnerKind;
  phase: RunnerPhase;
  reason: RunnerReason;
  objective?: string; // goal
  prompt?: string; // loop
  intervalSeconds?: number;
  workers: string[];
  checker?: string | null;
  checkpoint?: RunnerCheckpoint | null;
  limits: RunnerLimits;
  usage: RunnerUsage;
  startedAt: number;
  deadlineAt: number;
  nextRunAt?: number | null;
  pendingRequestId?: string | null;
  dismissed?: boolean;
}

export interface RunnerStart {
  schemaVersion: number;
  kind: RunnerKind;
  objective?: string;
  prompt?: string;
  intervalSeconds?: number;
  workers: string[];
  checker?: string | null;
  limits: RunnerLimits;
}

export type RunnerActionTag = 'pause' | 'resume' | 'end' | 'update_limits' | 'dismiss';

export interface RunnerAction {
  action: RunnerActionTag;
  expectedRevision?: number;
  requestId: string;
  limits?: RunnerLimits;
}

export interface IntervalParseResult {
  seconds: number;
}

const MIN_INTERVAL_S = 10;
const MAX_INTERVAL_S = 24 * 3600;

export function parseIntervalSeconds(raw: string): number {
  if (!raw) throw new Error('Interval required, e.g. 10m');
  const m = /^(\d+)([smh])$/i.exec(raw.trim());
  if (!m) {
    throw new Error(`Invalid interval "${raw}": expected <number><s|m|h>, e.g. 10m`);
  }
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid interval "${raw}": must be positive integer`);
  // reject fractional already by regex
  let seconds: number;
  if (unit === 's') seconds = n;
  else if (unit === 'm') seconds = n * 60;
  else seconds = n * 3600;
  if (seconds < MIN_INTERVAL_S) throw new Error(`Interval "${raw}" too short: minimum 10s`);
  if (seconds > MAX_INTERVAL_S) throw new Error(`Interval "${raw}" too long: maximum 24h`);
  return seconds;
}

export const DEFAULT_LIMITS: Omit<RunnerLimits, 'schemaVersion'> = {
  maxTurns: 30,
  maxInvocations: 120,
  lifetimeMs: 2 * 3600 * 1000,
  maxCostMicros: 5_000_000,
};

export function defaultLimits(): RunnerLimits {
  return { schemaVersion: SCHEMA_VERSION, ...DEFAULT_LIMITS };
}

export function validateLimits(l: RunnerLimits): void {
  if (l.maxTurns !== undefined) {
    if (!Number.isInteger(l.maxTurns) || l.maxTurns < 1 || l.maxTurns > 1000) throw new Error('maxTurns must be 1..1000');
  }
  if (l.maxInvocations !== undefined) {
    if (!Number.isInteger(l.maxInvocations) || l.maxInvocations < 1 || l.maxInvocations > 1000) throw new Error('maxInvocations 1..1000');
  }
  if (l.lifetimeMs < 60_000 || l.lifetimeMs > 24 * 3600 * 1000) throw new Error('lifetime 1m..24h');
  if (l.maxCostMicros != null) {
    if (l.maxCostMicros < 10_000 || l.maxCostMicros > 1_000_000_000_000) throw new Error('cost $0.01..$1000');
  }
}

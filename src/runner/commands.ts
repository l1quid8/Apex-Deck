import { parseIntervalSeconds } from './types.ts';

export type RunnerCommandKind = 'goal' | 'loop';

export type RunnerCommandParse =
  | { kind: 'show' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'start'; kindRunner: RunnerCommandKind; objective?: string; prompt?: string; intervalSeconds?: number; intervalRaw?: string }
  | { kind: 'error'; message: string };

const RESERVED = new Set(['pause', 'resume', 'clear']);

function isReservedSingleWord(arg: string): string | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  if (/^\s*$/.test(trimmed)) return null;
  if (trimmed.includes('\n')) return null;
  const lower = trimmed.toLowerCase();
  // Only exact single word matches, no extra whitespace words
  if (/^[a-z]+$/i.test(trimmed) && RESERVED.has(lower)) {
    return lower;
  }
  return null;
}

export function parseRunnerCommand(runnerKind: RunnerCommandKind, argRaw: string): RunnerCommandParse {
  const arg = (argRaw ?? '').trim();

  if (!arg) {
    return { kind: 'show' };
  }

  // Handle "start <rest>" for objectives that are reserved words
  const startMatch = /^start(?:\s+([\s\S]*))?$/i.exec(arg);
  if (startMatch) {
    const rest = (startMatch[1] ?? '').trim();
    if (runnerKind === 'goal') {
      if (!rest) return { kind: 'error', message: 'Goal objective required after "start"' } as RunnerCommandParse;
      return { kind: 'start', kindRunner: 'goal', objective: rest } as RunnerCommandParse;
    } else {
      // loop start <interval> <prompt>
      if (!rest) return { kind: 'error', message: 'Loop interval and prompt required, e.g. /loop 10m check build' } as RunnerCommandParse;
      return parseLoopStart(rest);
    }
  }

  const reserved = isReservedSingleWord(arg);
  if (reserved) {
    if (reserved === 'pause') return { kind: 'pause' };
    if (reserved === 'resume') return { kind: 'resume' };
    if (reserved === 'clear') return { kind: 'clear' };
  }

  // Otherwise it's a start
  if (runnerKind === 'goal') {
    return { kind: 'start', kindRunner: 'goal', objective: arg } as RunnerCommandParse;
  } else {
    return parseLoopStart(arg);
  }
}

function parseLoopStart(arg: string): RunnerCommandParse {
  // arg expected: <interval> <prompt>
  const parts = arg.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    return { kind: 'error', message: 'Loop interval required, e.g. 10m' };
  }
  const intervalRaw = parts[0];
  let seconds: number;
  try {
    seconds = parseIntervalSeconds(intervalRaw);
  } catch (e: any) {
    return { kind: 'error', message: e.message || `Invalid interval "${intervalRaw}"` };
  }
  const prompt = arg.trim().slice(intervalRaw.length).trim();
  if (!prompt) {
    return { kind: 'error', message: 'Loop prompt required after interval, e.g. /loop 10m check build' };
  }
  return { kind: 'start', kindRunner: 'loop', prompt, intervalSeconds: seconds, intervalRaw } as RunnerCommandParse;
}

import type { ParticipantConfig } from './types';

export function withTurnSettings(config: ParticipantConfig, model: string, effort: string, supported: string[]): ParticipantConfig {
  const backend = config.backend;
  return {
    ...config,
    backend: backend.kind === 'agent' ? { ...backend, model: model.trim() || null }
      : backend.kind === 'open_ai_compatible' ? { ...backend, model: model.trim() } : backend,
    effort: supported.includes(effort) ? effort : null,
  };
}

/** Merge a form against its opening values, preserving other clients' edits. */
export function mergeParticipant(current: ParticipantConfig, base: ParticipantConfig, next: ParticipantConfig): ParticipantConfig {
  function merge(current: unknown, base: unknown, next: unknown): unknown {
    if (JSON.stringify(base) === JSON.stringify(next)) return current;
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (object(current) && object(base) && object(next)) {
      if (base.kind !== next.kind || base.tool !== next.tool) return next;
      const result = { ...current };
      for (const key of Object.keys(next)) result[key] = merge(current[key], base[key], next[key]);
      for (const key of Object.keys(base)) if (!(key in next)) delete result[key];
      return result;
    }
    return next;
  }
  return merge(current, base, next) as ParticipantConfig;
}

/** Apply explicit picks to a fresh config, including picks back to the original value. */
export function applyTurnChange(current: ParticipantConfig, change: { model?: string; effort?: string; auto_effort?: boolean }): ParticipantConfig {
  let backend = current.backend;
  if ('model' in change) {
    if (backend.kind === 'agent') backend = { ...backend, model: change.model?.trim() || null };
    else if (backend.kind === 'open_ai_compatible') backend = { ...backend, model: change.model?.trim() || '' };
  }
  return { ...current, backend, effort: 'effort' in change ? change.effort || null : current.effort, auto_effort: change.auto_effort ?? ('effort' in change ? false : current.auto_effort ?? false) };
}

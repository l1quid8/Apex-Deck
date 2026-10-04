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

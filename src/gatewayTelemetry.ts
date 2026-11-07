import type { AgentTool, ParticipantConfig } from './types';

const families: Record<string, AgentTool> = { claude: 'claude_code', codex: 'codex', muse: 'muse', grok: 'grok', gemini: 'gemini' };

/** Remote subscription telemetry never shares a bucket with a local login. */
export function gatewayPlan(config: ParticipantConfig | undefined): boolean {
  const b = config?.backend;
  return b?.kind === 'open_ai_compatible' && Object.hasOwn(families, b.model.split('/')[0]);
}

export function planProvider(config: ParticipantConfig | undefined): AgentTool | null {
  const b = config?.backend;
  if (b?.kind === 'agent') return b.tool;
  return gatewayPlan(config) && b?.kind === 'open_ai_compatible' ? families[b.model.split('/')[0]] : null;
}

export function planModel(config: ParticipantConfig | undefined): string | null {
  const b = config?.backend;
  if (b?.kind === 'agent') return b.model;
  return gatewayPlan(config) && b?.kind === 'open_ai_compatible'
    ? `gateway:${JSON.stringify([b.base_url.trim().replace(/\/+$/, ''), b.api_key_env ?? '', b.model])}` : null;
}

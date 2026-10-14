import type { ParticipantBackend, Speed } from './types';

/** The tools whose bots offer a Speed choice. Others have no fast option, so the choice stays hidden. */
export const SPEED_TOOLS: readonly string[] = ['codex', 'claude_code'];

/** OpenAI-compatible alone is not a promise that service_tier is understood. */
export function supportsSpeed(backend: ParticipantBackend): boolean {
  if (backend.kind === 'agent') return SPEED_TOOLS.includes(backend.tool);
  if (backend.kind !== 'open_ai_compatible') return false;
  try {
    const url = new URL(backend.base_url.trim());
    return url.origin === 'https://api.openai.com' && url.pathname.replace(/\/+$/, '') === '/v1' && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

/** Empty follows the tool's own setting, so bots made before Speed existed keep behaving the same. */
export const SPEED_OPTIONS: { value: Speed | ''; text: string; title: string }[] = [
  { value: '', text: 'Default', title: "Follow the tool's own setting" },
  { value: 'standard', text: 'Standard', title: 'Normal speed and cost' },
  { value: 'fast', text: 'Fast', title: 'Quicker replies; higher cost or plan usage' },
];

export function speedHint(tool?: string): string {
  if (!tool) return "Fast requests OpenAI priority processing at a higher price, subject to model and account availability. Default follows your API project's setting.";
  return tool === 'codex'
    ? "Fast answers sooner and uses more of your plan. Default follows Codex's own setting (service_tier in config.toml)."
    : 'Fast answers sooner and costs more. Claude Code offers it on Opus models; others reply at standard speed.';
}

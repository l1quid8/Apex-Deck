import type { Speed } from './types';

/** The tools whose bots offer a Speed choice. Others have no fast option, so the choice stays hidden. */
export const SPEED_TOOLS: readonly string[] = ['codex', 'claude_code'];

/** Empty follows the tool's own setting, so bots made before Speed existed keep behaving the same. */
export const SPEED_OPTIONS: { value: Speed | ''; text: string; title: string }[] = [
  { value: '', text: 'Default', title: "Follow the tool's own setting" },
  { value: 'standard', text: 'Standard', title: 'Normal speed and cost' },
  { value: 'fast', text: 'Fast', title: 'Quicker replies, uses more of your plan' },
];

export function speedHint(tool: string): string {
  return tool === 'codex'
    ? "Fast answers sooner and uses more of your plan. Default follows Codex's own setting (service_tier in config.toml)."
    : 'Fast answers sooner and costs more. Claude Code offers it on Opus models; others reply at standard speed.';
}

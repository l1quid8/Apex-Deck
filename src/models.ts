// The models and effort levels offered in the group chat form.
//
// These lists are suggestions, not limits: every picker also accepts a name
// you type, and Codex's list is replaced by the one Codex itself reports
// when it has one (see `agent_models` in the desktop shell). When a tool
// adds or retires a model, this is the file to update.
//
// Last checked against each tool's own documentation in October 2026.

import type { AgentTool, ApiModel, ModelChoice } from "./types";
import { mediaKind, type MediaKind } from "./media.ts";

export interface ModelGroup {
  label: string;
  models: ModelChoice[];
}

/** Friendly names for effort levels. A level without one is shown as is. */
const EFFORT_LABELS: Record<string, string> = {
  none: "None (no thinking)",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export function effortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** Every effort level a tool understands, used when the model is not known. */
export const AGENT_EFFORTS: Record<AgentTool, string[]> = {
  claude_code: CLAUDE_EFFORTS,
  codex: CODEX_EFFORTS,
  // Gemini CLI has no effort setting on the command line.
  gemini: [],
  grok: ["low", "medium", "high", "xhigh"],
};

const FABLE_NOTE = "Fable can bill usage credits on top of a subscription, and a chat turn cannot ask you first.";

export const AGENT_MODELS: Record<AgentTool, ModelGroup[]> = {
  claude_code: [
    {
      label: "Latest (moves to each new version)",
      models: [
        { id: "opus", label: "Latest Opus" },
        { id: "sonnet", label: "Latest Sonnet" },
        { id: "haiku", label: "Latest Haiku", efforts: [] },
        { id: "fable", label: "Latest Fable", note: FABLE_NOTE },
        { id: "best", label: "Fable where available, otherwise Opus", note: FABLE_NOTE },
        { id: "opusplan", label: "Opus to plan, Sonnet to do the work" },
        { id: "opus[1m]", label: "Latest Opus, 1M context" },
        { id: "sonnet[1m]", label: "Latest Sonnet, 1M context" },
      ],
    },
    {
      label: "Fable",
      models: [
        { id: "claude-fable-5-1", label: "Fable 5.1", note: FABLE_NOTE },
        { id: "claude-fable-5", label: "Fable 5", note: FABLE_NOTE },
      ],
    },
    {
      label: "Opus",
      models: [
        { id: "claude-opus-5-5", label: "Opus 5.5" },
        { id: "claude-opus-5", label: "Opus 5" },
        { id: "claude-opus-4-8", label: "Opus 4.8" },
        { id: "claude-opus-4-7", label: "Opus 4.7" },
        { id: "claude-opus-4-6", label: "Opus 4.6" },
      ],
    },
    {
      label: "Sonnet",
      models: [
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
        { id: "claude-sonnet-5", label: "Sonnet 5" },
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
        { id: "claude-sonnet-4-5", label: "Sonnet 4.5", efforts: [] },
      ],
    },
    {
      label: "Haiku",
      models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] }],
    },
  ],
  codex: [
    {
      label: "Current",
      models: [
        { id: "gpt-6.1-sol", label: "GPT-6.1 Sol, close to Astra at lower cost" },
        { id: "gpt-6-astra", label: "Astra, the most capable" },
        { id: "gpt-6-luna", label: "GPT-6 Luna, fastest", efforts: ["low", "medium", "high", "max"] },
      ],
    },
    {
      label: "Older",
      models: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], note: "GPT-5.5 retires from Codex on October 14, 2026." }],
    },
  ],
  gemini: [
    {
      label: "Shortcuts (Gemini CLI picks the version)",
      models: [
        { id: "auto", label: "Pro or Flash, chosen per request" },
        { id: "pro", label: "Latest Pro" },
        { id: "flash", label: "Latest Flash" },
        { id: "flash-lite", label: "Latest Flash-Lite" },
      ],
    },
    {
      label: "Pro",
      models: [
        { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      ],
    },
    {
      label: "Flash",
      models: [
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
        { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
        { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
        { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
        { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)" },
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      ],
    },
    {
      label: "Flash-Lite",
      models: [
        { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
        { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      ],
    },
  ],
  grok: [
    {
      label: "Grok",
      models: [
        { id: "grok-4.7", label: "Grok 4.7" },
        { id: "grok-4.7-build-fast", label: "Grok 4.7 Fast" },
        { id: "grok-4.6", label: "Grok 4.6" },
        { id: "grok-4.5", label: "Grok 4.5", efforts: ["low", "medium", "high"] },
      ],
    },
  ],
};

/** Effort levels for servers that speak the OpenAI-style API. */
export const API_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

export function findModel(groups: ModelGroup[], id: string): ModelChoice | undefined {
  const wanted = id.trim();
  if (!wanted) return undefined;
  for (const group of groups) {
    const hit = group.models.find((m) => m.id === wanted);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The groups to offer for a tool, given what the tool itself reported.
 *
 * Reported models come first, because they are what the signed-in account
 * can really use. Built-in names the tool did not report are kept under
 * their own heading rather than dropped, since the tool's list can be stale.
 * A reported model keeps the built-in note, and the built-in effort levels
 * when the tool did not say which it accepts.
 */
export function modelGroups(tool: AgentTool, reported: ModelChoice[], toolLabel: string): ModelGroup[] {
  const builtIn = AGENT_MODELS[tool];
  if (reported.length === 0) return builtIn;
  const seen = new Set(reported.map((m) => m.id));
  const merged = reported.map((m) => {
    const known = findModel(builtIn, m.id);
    return { ...m, label: m.label ?? known?.label, efforts: m.efforts ?? known?.efforts, note: known?.note };
  });
  const rest = builtIn.flatMap((g) => g.models).filter((m) => !seen.has(m.id));
  const groups: ModelGroup[] = [{ label: `Offered to your ${toolLabel} account`, models: merged }];
  if (rest.length > 0) groups.push({ label: "Other known models", models: rest });
  return groups;
}

/**
 * Least reasoning first. The slider and the picker both read left to right,
 * and low to high. A level not listed here stays after these, in the order
 * it was given.
 */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function leastReasoningFirst(levels: readonly string[]): string[] {
  const rank = (level: string) => {
    const index = EFFORT_ORDER.indexOf(level);
    return index === -1 ? EFFORT_ORDER.length : index;
  };
  // Copy first. Sorting the model's own list would reverse it for the next read.
  return [...levels].sort((a, b) => rank(a) - rank(b));
}

/**
 * The effort levels to offer for `modelId`. An empty result means the model
 * has no effort setting. With no model picked, or one this list does not
 * know, every level the tool understands is offered.
 *
 * The result is always least reasoning first. Grok's own catalog lists the
 * levels the other way, highest first, and a slider that follows that order
 * turns reasoning down as the thumb moves right.
 */
export function effortsFor(all: string[], groups: ModelGroup[], modelId: string): string[] {
  const model = findModel(groups, modelId);
  return leastReasoningFirst(model?.efforts ?? all);
}

/** Model names from `api_models`. Older servers send strings; newer ones send objects. */
export function apiModelList(raw: unknown): ApiModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiModel[] = [];
  for (const item of raw) {
    if (typeof item === 'string') { if (item) out.push({ id: item }); }
    else if (item && typeof item === 'object' && typeof (item as ApiModel).id === 'string' && (item as ApiModel).id) out.push(item as ApiModel);
  }
  return out;
}

/** "1M", "1.5M", "128K". Empty when the size is unknown. */
export function contextSize(tokens: number | null | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/**
 * The provider's models as menu groups. A list of text models is one group, as before.
 * Once it has picture or video models, the groups are Text, Image and Video (only those with models).
 * Picture and video models take no reasoning level, so they list none.
 */
export function apiModelGroups(models: ApiModel[]): ModelGroup[] {
  if (models.length === 0) return [];
  const row = (m: ApiModel): ModelChoice => {
    const size = contextSize(m.context_tokens);
    const name = m.label || m.id;
    return { id: m.id, label: size ? `${name} · ${size} context` : name, efforts: mediaKind(m) ? [] : m.efforts };
  };
  if (models.every(m => !mediaKind(m))) return [{ label: 'Offered by this provider', models: models.map(row) }];
  const sections: { label: string; kind: MediaKind | null }[] = [{ label: 'Text', kind: null }, { label: 'Image', kind: 'image' }, { label: 'Video', kind: 'video' }];
  return sections
    .map(s => ({ label: s.label, models: models.filter(m => mediaKind(m) === s.kind).map(row) }))
    .filter(g => g.models.length > 0);
}

/** The level new bots start on: medium if offered, else the nearest one above it, else the nearest below. */
export function defaultEffortFor(efforts: string[]): string {
  const medium = EFFORT_ORDER.indexOf('medium');
  if (efforts.includes('medium')) return 'medium';
  for (let i = medium + 1; i < EFFORT_ORDER.length; i++) if (efforts.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  for (let i = medium - 1; i >= 0; i--) if (efforts.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  return efforts[0] ?? '';
}

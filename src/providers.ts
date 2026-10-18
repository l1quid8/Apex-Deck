import type { ParticipantConfig } from "./types";

export function providerEnabled(id: string, disabled: readonly string[]): boolean {
  if (id === "claude_code") return !disabled.includes("claude");
  if (id === "gemini" || id === "antigravity") return !disabled.includes("gemini") && !disabled.includes("antigravity");
  return !disabled.includes(id);
}

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export function providerForConfig(config: ParticipantConfig): string {
  const backend = config.backend;
  if (backend.kind === "agent") return backend.tool;
  if (backend.kind === "cli") return "command";
  if (backend.kind === "scripted") return "scripted";
  const url = backend.base_url.trim().replace(/\/$/, "");
  if (url === "http://localhost:11434/v1") return "ollama";
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL */ }
  return host === "api.deepseek.com" ? "deepseek" : "api";
}

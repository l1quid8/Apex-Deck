import type { ParticipantConfig } from "./types";

export function providerEnabled(id: string, disabled: readonly string[]): boolean {
  if (id === "claude_code") return !disabled.includes("claude");
  if (id === "gemini" || id === "antigravity") return !disabled.includes("gemini") && !disabled.includes("antigravity");
  return !disabled.includes(id);
}

export function providerForConfig(config: ParticipantConfig): string {
  const backend = config.backend;
  if (backend.kind === "agent") return backend.tool;
  if (backend.kind === "cli") return "command";
  if (backend.kind === "scripted") return "scripted";
  return backend.base_url.replace(/\/$/, "") === "http://localhost:11434/v1" ? "ollama" : "api";
}

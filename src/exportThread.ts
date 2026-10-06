import { parseBlocks, parseInline, type Inline } from "./markdownText.ts";
import type { Compaction, Message, ParticipantConfig } from "./types";

/** Blocks remote loads. Inline styles are the only exception, and there is no script. */
export const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** What an export needs from a thread. */
export interface ThreadExport {
  title: string;
  participants: ParticipantConfig[];
  transcript: Message[];
  pins: string[];
  compaction: Compaction | null;
}

const day = (at: Date) => at.toISOString().slice(0, 10);

function speakerName(message: Message, participants: ParticipantConfig[]): string {
  if (message.speaker.kind === "human") return "Human";
  const id = message.speaker.id;
  return participants.find((p) => p.id === id)?.display_name ?? id;
}

/** A readable copy of every saved message, without the model compaction summary. */
export function exportMarkdown(t: ThreadExport, at: Date): string {
  const who = t.participants.map((p) => `${p.display_name} (@${p.id})`).join(", ") || "none";
  const parts = [`# ${t.title.trim() || "Thread"}`, `Exported from Apex Deck on ${day(at)}. Participants: ${who}.`];
  if (t.pins.length > 0) parts.push(`## Pinned\n\n${t.pins.map((p) => `- ${p}`).join("\n")}`);
  parts.push("---");
  for (const message of t.transcript) parts.push(`### ${speakerName(message, t.participants)}\n\n${message.text}`);
  return parts.join("\n\n") + "\n";
}

/** The raw thread, for a later re-import. */
export function exportJson(t: ThreadExport, at: Date): string {
  return JSON.stringify({ ...t, format: "apex-deck-thread", version: 1, exported_at: at.toISOString() }, null, 2) + "\n";
}

export function exportFileName(title: string, format: "markdown" | "json" | "pdf", at: Date): string {
  const safe = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^\./, "-").slice(0, 80) || "Thread";
  const ext = format === "json" ? "json" : format === "pdf" ? "pdf" : "md";
  return `${safe} ${day(at)}.${ext}`;
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlineHtml(source: string): string {
  const draw = (span: Inline): string => {
    switch (span.kind) {
      case "text": return esc(span.text);
      case "code": return `<code>${esc(span.text)}</code>`;
      case "bold": return `<strong>${span.children.map(draw).join("")}</strong>`;
      case "italic": return `<em>${span.children.map(draw).join("")}</em>`;
      case "strike": return `<s>${span.children.map(draw).join("")}</s>`;
    }
  };
  return parseInline(source).map(draw).join("");
}

function bodyHtml(text: string): string {
  return parseBlocks(text).map((block) => {
    switch (block.kind) {
      case "paragraph": return `<p>${inlineHtml(block.text)}</p>`;
      case "heading": return `<p class="h">${inlineHtml(block.text)}</p>`;
      case "code": return `<pre>${esc(block.text)}</pre>`;
      case "quote": return `<blockquote>${inlineHtml(block.text)}</blockquote>`;
      case "rule": return "<hr>";
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag}>${block.items.map((item) => `<li>${inlineHtml(item.text)}</li>`).join("")}</${tag}>`;
      }
      case "table": {
        const head = block.header.map((cell) => `<th>${inlineHtml(cell)}</th>`).join("");
        const rows = block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join("")}</tr>`).join("");
        return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
      }
    }
  }).join("\n");
}

function stamp(at: number | undefined): string {
  if (at === undefined) return "";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return `<time datetime="${esc(when.toISOString())}">${esc(when.toLocaleString())}</time>`;
}

/** A printable page of the chat. No scripts, no remote URLs, no raw HTML from messages. */
export function exportHtml(t: ThreadExport, at: Date): string {
  const title = t.title.trim() || "Thread";
  const who = t.participants.map((p) => `${p.display_name} (@${p.id})`).join(", ") || "none";
  const pins = t.pins.length
    ? `<section class="pins"><h2>Pinned</h2><ul>${t.pins.map((pin) => `<li>${esc(pin)}</li>`).join("")}</ul></section>`
    : "";
  const messages = t.transcript.map((message) => {
    const name = speakerName(message, t.participants);
    const short = message.text.length < 400 ? " short" : "";
    const mine = message.speaker.kind === "human" ? " human" : "";
    return `<article class="message${mine}${short}"><header><strong>${esc(name)}</strong>${stamp(message.at)}</header>${bodyHtml(message.text)}</article>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">
<title>${esc(title)}</title>
<style>
@page { margin: 16mm; }
body { margin: 0; color: #1a1a1a; background: #fff; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; }
.meta, time { color: #555; font-size: 12px; }
time { margin-left: 8px; }
.message { margin: 0 0 12px; padding: 8px 12px; border-radius: 10px; background: #f3f4f6; }
.message.human { background: #e7f1fb; }
.message.short { break-inside: avoid; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
td, th { border: 1px solid #ccc; padding: 4px 6px; word-break: break-word; text-align: left; vertical-align: top; }
blockquote { margin: 8px 0; padding-left: 10px; border-left: 3px solid #ccc; }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">Exported from Apex Deck on ${day(at)}. Participants: ${esc(who)}.</p>
${pins}
${messages}
</body></html>
`;
}

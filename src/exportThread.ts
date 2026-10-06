import { identiconCells, legacyAppearance } from "./identicon.ts";
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

/** "12:52 AM", with the date in front when it is not the export day. */
function stamp(at: number | undefined, exported: Date): string {
  if (at === undefined) return "";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const shown = when.toDateString() === exported.toDateString()
    ? time
    : `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  return `<time datetime="${esc(when.toISOString())}">${esc(shown)}</time>`;
}

/** The bot's 5×5 avatar as inline SVG, so the offline window can draw it. */
function avatarSvg(id: string, participants: ParticipantConfig[]): string {
  const look = participants.find((p) => p.id === id)?.appearance ?? legacyAppearance(id);
  const color = /^#[0-9a-f]{3,8}$/i.test(look.color) ? look.color : "#91a0af";
  const cells = identiconCells(look.seed).map((cell, i) => {
    const x = 7 + (i % 5) * 6;
    const y = 7 + Math.floor(i / 5) * 6;
    return `<rect x="${x}" y="${y}" width="5" height="5" rx="1" fill="${color}"${cell.on ? "" : ' fill-opacity="0.09"'}/>`;
  }).join("");
  return `<svg class="avatar" viewBox="0 0 43 43" width="32" height="32" aria-hidden="true"><rect x="0.5" y="0.5" width="42" height="42" rx="10" fill="#0e141b" stroke="${color}" stroke-opacity="0.32"/>${cells}</svg>`;
}

/** A printable page of the chat. No scripts, no remote URLs, no raw HTML from messages. */
export function exportHtml(t: ThreadExport, at: Date): string {
  const title = t.title.trim() || "Thread";
  const who = t.participants.map((p) => `${p.display_name} (@${p.id})`).join(", ") || "none";
  const pins = t.pins.length
    ? `<section class="pins"><h2>Pinned</h2><ul>${t.pins.map((pin) => `<li>${esc(pin)}</li>`).join("")}</ul></section>`
    : "";
  const messages = t.transcript.map((message) => {
    const name = esc(speakerName(message, t.participants));
    const short = message.text.length < 1200 ? " short" : "";
    const header = `<header><strong>${name}</strong>${stamp(message.at, at)}</header>`;
    if (message.speaker.kind === "human") {
      return `<div class="row human${short}"><div class="who">${header}</div><article class="bubble human">${bodyHtml(message.text)}</article></div>`;
    }
    return `<div class="row bot${short}">${avatarSvg(message.speaker.id, t.participants)}<div class="col"><div class="who">${header}</div><article class="bubble bot">${bodyHtml(message.text)}</article></div></div>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">
<title>${esc(title)}</title>
<style>
@page { margin: 0; }
html { background: #090d12; }
body { margin: 0; padding: 0 14mm; color: #e4eaf0; background: #090d12; font: 13px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
table.page { width: 100%; border-collapse: collapse; }
.page > thead td { height: 12mm; padding: 0; border: 0; }
.page > tfoot td { height: 10mm; padding: 0; border: 0; }
.page > tbody > tr > td { padding: 0; border: 0; }
h1 { font-size: 20px; font-weight: 650; margin: 0 0 2px; }
.meta, .pins { color: #91a0af; font-size: 12px; }
.pins { margin: 12px 0; }
.thread { display: flex; flex-direction: column; gap: 18px; margin-top: 20px; }
.row { display: flex; gap: 10px; max-width: 85%; }
.row.short { break-inside: avoid; }
.row.human { align-self: flex-end; flex-direction: column; align-items: flex-end; }
.row.bot { align-self: flex-start; align-items: flex-start; }
.col { display: flex; flex-direction: column; min-width: 0; }
.avatar { flex: none; margin-top: 2px; }
.who { break-after: avoid; }
header { display: flex; align-items: baseline; gap: 8px; margin: 0 4px 4px; font-size: 12px; }
header strong { font-weight: 600; }
time { color: #91a0af; font-size: 11px; }
.bubble { box-sizing: border-box; -webkit-box-decoration-break: clone; box-decoration-break: clone; padding: 10px 14px; border-radius: 12px; overflow-wrap: anywhere; }
.bubble.human { background: #17332d; }
.bubble.bot { background: #151e28; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0; padding: 10px 12px; border-radius: 8px; background: #0b1016; }
code { background: #0b1016; padding: 0 4px; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
td, th { border: 1px solid #24303d; padding: 4px 6px; word-break: break-word; text-align: left; vertical-align: top; }
blockquote { margin: 8px 0; padding-left: 10px; border-left: 3px solid #24303d; color: #91a0af; }
ul, ol { margin: 0 0 8px; padding-left: 20px; }
p { margin: 0 0 8px; }
p:last-child, ul:last-child, ol:last-child, pre:last-child { margin-bottom: 0; }
</style></head><body>
<table class="page"><thead><tr><td></td></tr></thead><tfoot><tr><td></td></tr></tfoot><tbody><tr><td>
<h1>${esc(title)}</h1>
<p class="meta">Exported from Apex Deck on ${day(at)}. Participants: ${esc(who)}.</p>
${pins}
<div class="thread">
${messages}
</div>
</td></tr></tbody></table>
</body></html>
`;
}

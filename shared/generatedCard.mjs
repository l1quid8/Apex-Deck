// The generated-card wire contract is shared by untrusted reply readers and
// Electron main. This module validates data only; it never interprets code.

export const GENERATED_LIMITS = Object.freeze({
  htmlBytes: 49_152,
  cssBytes: 16_384,
  jsBytes: 32_768,
  codeBytes: 65_536,
  sourceBytes: 131_072,
  sourceCodeUnits: 131_072,
  titleChars: 80,
  summaryChars: 280,
  fallbackChars: 4_000,
});

const FIELDS = ["schemaVersion", "kind", "cardId", "title", "summary", "html", "css", "js", "fallback"];
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const encoder = new TextEncoder();
const refused = (reason) => ({ ok: false, reason, unsupported: false });
const count = (number) => number.toLocaleString("en-US");

/** Validate an already decoded card, including main-process IPC payloads. */
export function validateGeneratedCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refused("The card must be a JSON object.");
  // IPC supplies plain structured data. Own keys also prevent inherited fields
  // from satisfying this contract when the validator is used directly.
  const keys = Reflect.ownKeys(value);
  for (const field of keys) {
    if (typeof field !== "string" || !FIELDS.includes(field)) return refused(`Unknown generated card field "${String(field).slice(0, 80)}".`);
  }
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return refused(`${field} must be present.`);
  }
  if (value.schemaVersion !== 1) return refused("schemaVersion must be 1 for a generated card.");
  if (value.kind !== "generated") return refused('kind must be "generated".');
  if (typeof value.cardId !== "string" || !ID.test(value.cardId)) return refused("cardId must be a short id of lowercase letters, digits, - or _.");
  for (const [field, limit] of [["title", GENERATED_LIMITS.titleChars], ["summary", GENERATED_LIMITS.summaryChars], ["fallback", GENERATED_LIMITS.fallbackChars]]) {
    if (typeof value[field] !== "string" || !value[field].trim()) return refused(`${field} must be nonblank text.`);
    if (value[field].length > limit) return refused(`${field} is longer than ${count(limit)} characters.`);
  }
  let codeBytes = 0;
  for (const [field, limit] of [["html", GENERATED_LIMITS.htmlBytes], ["css", GENERATED_LIMITS.cssBytes], ["js", GENERATED_LIMITS.jsBytes]]) {
    const code = value[field];
    if (typeof code !== "string" || (field === "html" && !code.trim())) return refused(`${field} must be ${field === "html" ? "nonblank " : ""}text.`);
    // UTF-8 is never shorter than the UTF-16 code-unit count, so this first
    // check bounds encoding allocations for already-decoded IPC payloads.
    if (code.length > limit) return refused(`${field} is larger than ${count(limit)} UTF-8 bytes.`);
    const bytes = encoder.encode(code).byteLength;
    if (bytes > limit) return refused(`${field} is larger than ${count(limit)} UTF-8 bytes.`);
    codeBytes += bytes;
  }
  if (codeBytes > GENERATED_LIMITS.codeBytes) return refused(`Combined generated code is larger than ${count(GENERATED_LIMITS.codeBytes)} UTF-8 bytes.`);
  // Copy the allowlisted fields without normalizing any string: code, including
  // whitespace, line endings and literal </script>, remains exactly as sent.
  return { ok: true, card: {
    schemaVersion: 1, kind: "generated", cardId: value.cardId,
    title: value.title, summary: value.summary,
    html: value.html, css: value.css, js: value.js, fallback: value.fallback,
  } };
}

/** Read only a bounded serialized source, then apply the same validator. */
export function readGeneratedCard(source) {
  if (typeof source !== "string") return refused("The card source must be text.");
  if (source.length > GENERATED_LIMITS.sourceCodeUnits) return refused(`The card source is larger than ${count(GENERATED_LIMITS.sourceCodeUnits)} UTF-16 code units.`);
  if (encoder.encode(source).byteLength > GENERATED_LIMITS.sourceBytes) return refused(`The card source is larger than ${count(GENERATED_LIMITS.sourceBytes)} UTF-8 bytes.`);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return refused("The card isn't valid JSON.");
  }
  return validateGeneratedCard(value);
}

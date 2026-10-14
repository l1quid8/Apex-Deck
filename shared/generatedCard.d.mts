export interface GeneratedCard {
  schemaVersion: 1;
  kind: "generated";
  cardId: string;
  title: string;
  summary: string;
  /** Body-fragment markup, preserved verbatim. */
  html: string;
  /** Styles and behavior may be empty, and are preserved verbatim. */
  css: string;
  js: string;
  /** Nonblank plain text, never generated markup. */
  fallback: string;
}

export type GeneratedCardRead = { ok: true; card: GeneratedCard } | { ok: false; reason: string; unsupported: false };

export const GENERATED_LIMITS: Readonly<{
  htmlBytes: 49_152;
  cssBytes: 16_384;
  jsBytes: 32_768;
  codeBytes: 65_536;
  sourceBytes: 131_072;
  sourceCodeUnits: 131_072;
  titleChars: 80;
  summaryChars: 280;
  fallbackChars: 4_000;
}>;

export function validateGeneratedCard(value: unknown): GeneratedCardRead;
export function readGeneratedCard(source: string): GeneratedCardRead;

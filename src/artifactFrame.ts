// The document an HTML or SVG artifact runs as. The frame's sandbox (an
// opaque origin, scripts only) is the boundary; this policy is a second line
// that keeps the artifact off the network. See the spec, 2.4.

export const FRAME_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const META = `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`;

export function frameDocument(kind: "html" | "svg", source: string): string {
  if (kind === "svg") {
    return `<!doctype html><html><head>${META}<meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${source}</body></html>`;
  }
  // Never search source markup for an insertion point: comments and raw-text
  // elements can hide apparent head tags, and resources can load before them.
  // The HTML parser establishes this trusted head before seeing any source.
  return `<!doctype html><html><head>${META}<meta charset="utf-8"></head>${source}</html>`;
}

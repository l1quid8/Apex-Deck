// Trusted policy only. No model bytes, environment flags, or renderer claims
// can establish the packaged-runtime release gates.
export const WRAPPER_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src about:; child-src about:; worker-src 'none'; object-src 'none'; media-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";
export const WRAPPER_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': WRAPPER_CSP,
  'Connection-Allowlist': '()',
  'X-DNS-Prefetch-Control': 'off',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()',
});
export function runtimeCapability() {
  return { enabled: false, reason: 'Generated interfaces are disabled until the packaged Electron security and recovery gates have been independently verified. The text answer remains available.' };
}
export const GENERATED_WEB_PREFERENCES = Object.freeze({
  sandbox: true, contextIsolation: true, webSecurity: true,
  nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
  webviewTag: false, plugins: false, webgl: false, spellcheck: false, devTools: false,
  allowRunningInsecureContent: false, navigateOnDragDrop: false,
  disableBlinkFeatures: 'FileSystemAccess',
  safeDialogs: true, disableDialogs: true, v8CacheOptions: 'none',
});
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function checkedBounds(value, content) {
  if (!exact(value, ['x', 'y', 'width', 'height']) || !content) return null;
  if (!Object.values(value).every(Number.isSafeInteger)) return null;
  // Reserve the window title/toolbar. The exact visible card rectangle comes
  // only from the owner Deck main frame; overlays/unmounts send null to stop.
  if (value.x < 0 || value.y < 40 || value.width < 1 || value.height < 200 || value.height > 800
      || value.x + value.width > content.width || value.y + value.height > content.height) return null;
  return { ...value };
}
export function bootstrapRequestAllowed(details, url, live) {
  return live && details.url === url && details.resourceType === 'mainFrame';
}
export function frameSnapshot(contents) {
  try {
    if (contents.isDestroyed()) return null;
    return contents.mainFrame.framesInSubtree.map(frame => ({
      pid: frame.osProcessId, node: frame.frameTreeNodeId, url: frame.url, detached: frame.detached,
    }));
  } catch { return null; }
}
export function collectOwnership(generated, allContents, metrics) {
  const frames = frameSnapshot(generated);
  if (!frames || frames.length !== 2 || frames.some(frame => frame.detached || !Number.isSafeInteger(frame.pid) || frame.pid <= 0)
      || frames[1].url !== 'about:srcdoc') return { ok: false, reason: 'Generated frame ownership is not established.' };
  const records = [...new Set(frames.map(frame => frame.pid))].map(pid => ({
    pid, creationTime: metrics.find(metric => metric.pid === pid)?.creationTime,
    nodes: frames.filter(frame => frame.pid === pid).map(frame => frame.node),
  }));
  if (records.some(record => !Number.isFinite(record.creationTime))) return { ok: false, reason: 'Generated process identity is unavailable.' };
  for (const contents of allContents) {
    if (contents === generated || contents.id === generated.id) continue;
    const other = frameSnapshot(contents);
    // Fail closed if any live contents cannot be inspected.
    if (!other && !contents.isDestroyed()) return { ok: false, reason: 'Another renderer could not be inspected.' };
    if (other?.some(frame => records.some(record => record.pid === frame.pid))) return { ok: false, reason: 'Generated code shares a renderer with Deck.' };
  }
  return { ok: true, records, frames };
}
export function recheckOwnedProcess(record, generated, allContents, metrics) {
  if (!record || metrics.find(metric => metric.pid === record.pid)?.creationTime !== record.creationTime) return false;
  const frames = frameSnapshot(generated);
  if (!frames?.some(frame => !frame.detached && frame.pid === record.pid && record.nodes.includes(frame.node))) return false;
  for (const contents of allContents) {
    if (contents === generated || contents.id === generated.id) continue;
    const other = frameSnapshot(contents);
    if (!other && !contents.isDestroyed()) return false;
    if (other?.some(frame => frame.pid === record.pid)) return false;
  }
  return true;
}

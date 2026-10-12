import { useEffect, useState } from "react";
import type { BrowserApi, BrowserState } from "./backend";
import { BrowserView } from "./BrowserView";

export function normalise(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

export function RightBrowser({ id, url, browser, visible, onUrl }: { id: string; url: string; browser?: BrowserApi; visible: boolean; onUrl: (url: string) => void }) {
  const pane = `side:${id}`;
  const [typed, setTyped] = useState(url);
  const [page, setPage] = useState<BrowserState | null>(null);
  useEffect(() => setTyped(url), [url]);
  if (!browser) return <p className="muted right-panel-empty">The browser tab needs the Deck app.</p>;
  const go = (value: string) => { const address = normalise(value); if (!address) return; setTyped(address); onUrl(address); if (address === url) void browser.navigate(pane, address); };
  return <div className="right-browser"><form className="right-browser-bar" onSubmit={(event) => { event.preventDefault(); go(typed); }}>
    <button type="button" className="icon small" disabled={!page?.canGoBack} onClick={() => void browser.back(pane)} aria-label="Back">‹</button><button type="button" className="icon small" disabled={!page?.canGoForward} onClick={() => void browser.forward(pane)} aria-label="Forward">›</button><button type="button" className="icon small" disabled={!url} onClick={() => void browser.reload(pane)} aria-label="Reload">↻</button><input aria-label="Address" placeholder="Search or type an address" value={typed} onChange={(event) => setTyped(event.target.value)} />
  </form>{!url && <div className="right-browser-start"><button onClick={() => go("localhost:3000")}>localhost:3000</button><button onClick={() => go("localhost:5173")}>localhost:5173</button></div>}{url && <BrowserView pane={pane} url={url} browser={browser} visible={visible} onState={setPage} />}</div>;
}

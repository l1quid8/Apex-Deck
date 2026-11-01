// The live preview on the Appearance page: a same-origin frame running Deck's
// real stylesheets, so theme tokens stay out of the neutral editor around it.
// The frame loads no backend and no startup state. It paints what it is sent.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ApprovalCard } from "./ApprovalCard";
import { Avatar } from "./Avatar";
import { ChipSampleRow } from "./ChipStylePicker";
import { Markdown } from "./Markdown";
import type { AppearanceDraft } from "./appearanceDraft";
import type { ChipParts } from "./botChip";
import { LandingTexture } from "./landing/LandingTexture";
import { DEFAULT_LANDING_TEXTURE, effectiveLandingTexture, type LandingTextureSettings } from "./settings";
import { applyAppearance, effectiveLightFromMode, type AppearanceValues } from "./themes";
import type { ProposedAction } from "./types";

const READY = "appearance-preview-ready";
export type PreviewScene = "thread" | "empty";
interface PreviewMessage { type: "appearance-preview"; values: AppearanceValues; botChips: ChipParts; landingTexture?: LandingTextureSettings; scene?: PreviewScene }

const PAGE_URL = () => `${window.location.pathname}?appearance-preview=1`;

/** The frame, fed at most once per animation frame. */
export function AppearancePreview({ draft, systemDark, scene }: { draft: AppearanceDraft; systemDark: boolean; scene: PreviewScene }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const message = useRef<PreviewMessage | null>(null);
  const queued = useRef(0);
  const [src] = useState(PAGE_URL);

  const send = () => {
    queued.current = 0;
    if (message.current) frame.current?.contentWindow?.postMessage(message.current, window.location.origin);
  };

  const light = effectiveLightFromMode(draft.colorMode, systemDark, draft.values.light);
  message.current = { type: "appearance-preview", values: { ...draft.values, light }, botChips: draft.botChips, landingTexture: draft.landingTexture, scene };
  useEffect(() => {
    queued.current ||= requestAnimationFrame(send);
  }, [draft, light, scene]);

  useEffect(() => {
    const onReady = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === frame.current?.contentWindow && event.data?.type === READY) send();
    };
    window.addEventListener("message", onReady);
    return () => { window.removeEventListener("message", onReady); cancelAnimationFrame(queued.current); };
  }, []);

  return <iframe ref={frame} className="studio-preview-frame" title="Preview of your draft" src={src} sandbox="allow-scripts allow-same-origin" />;
}

const REPLY = `Found it. The retry wrapper in \`payments/client.ts\` re-sends every failed request, including ones the provider accepted but timed out on. The idempotency key is created inside the loop, so each attempt looks like a new charge.

Tuesday's config change dropped the timeout from 30 seconds to 8, which is why it started then. About 1 in 400 checkouts land in that window, mostly on slow card networks.

\`\`\`diff
// payments/client.ts
- for (let i = 0; i < retries; i++) {
-   const key = crypto.randomUUID();
+ const key = crypto.randomUUID();
+ for (let i = 0; i < retries; i++) {
    await charge(order, { idempotencyKey: key, attempt: i });
\`\`\``;
const FOLLOW_UP = "31 orders, £4,212 in total. The list is in `docs/refunds-nov.csv`, sorted by amount.";
const APPROVAL: ProposedAction = { kind: "command", title: "Run npm test payments", detail: "npm test payments" };
const SIDE_THREADS = [["Refund export", "2h"], ["Pricing page", "1d"], ["iOS release", "4d"]];
const noDecision = () => {};
const noOpen = () => {};

/** Fixed sample content in Deck's real markup, chosen to show readability
 *  problems: long text, code, an error, a choice, an approval, muted lines. */
export function AppearancePreviewPage() {
  const [message, setMessage] = useState<PreviewMessage | null>(null);
  const transcript = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "appearance-preview") return;
      setMessage(event.data as PreviewMessage);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: READY }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useLayoutEffect(() => {
    if (message) return applyAppearance(document.documentElement, message.values);
  }, [message?.values]);

  // Threads open on the newest message, as in Deck.
  useLayoutEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [message !== null, message?.scene]);

  const chips = message?.botChips;
  const details = chips ? [...(chips.tool ? ["Opus"] : []), ...(chips.effort ? ["high"] : []), ...(chips.usage ? ["ctx 81%"] : [])] : [];
  return <div className="appearance-preview-page" aria-hidden="false">
    <div className="preview-deck">
      <aside className="rail preview-rail">
        <p className="preview-rail-label">Projects</p>
        <p className="preview-rail-row current">Checkout double charges</p>
        {SIDE_THREADS.map(([name, age]) => <p key={name} className="preview-rail-row">{name}<small>{age}</small></p>)}
      </aside>
      <section className="pane focused preview-pane">
        <div className="pane-head"><span className="pane-title">Checkout double charges</span><span className="pane-folder">payments</span></div>
        <div data-bot-chip-style={chips?.style ?? "classic"} className="chat thread-chat">
          <div className="chat-body">
            {message?.scene === "empty" ? <div className="transcript">
              <div className="empty">
                <LandingTexture settings={effectiveLandingTexture(message.landingTexture ?? DEFAULT_LANDING_TEXTURE, message.values)} />
                <div className="empty-copy"><span className="eyebrow">A fresh perspective starts here</span><h3>What are we working on?</h3></div>
              </div>
            </div> : <div className="transcript" ref={transcript} tabIndex={0} aria-label="Sample conversation">
              <div className="message-row human-row"><div className="bubble human">Checkout retries have been double-charging some customers since Tuesday. Can you find out why and fix it?</div></div>
              <div className="bot-row message-row">
                <Avatar seed="jigga" color="#a3e635" />
                <div className="bubble bot completed" style={{ "--agent-color": "#a3e635" } as React.CSSProperties}>
                  <span className="speaker">Jigga</span>
                  <p className="preview-steps">Read 6 files · ran 2 commands · 41s · 9:41 AM</p>
                  <Markdown text={REPLY} onOpen={noOpen} />
                  <div className="preview-error" role="presentation"><strong>2 tests failed</strong><code>payments/retry.test.ts › reuses one key across attempts</code><code>Expected 1 charge, received 2</code><small>at retry.test.ts:48:14. Run before this patch.</small></div>
                  <div className="preview-ask"><strong>Which calls should retry?</strong><span className="on">Only calls with an idempotency key</span><span>All charges and refunds</span></div>
                  <ApprovalCard action={APPROVAL} name="Null" onDecide={noDecision} />
                </div>
              </div>
              <div className="message-row human-row"><div className="bubble human">Who was affected?</div></div>
              <div className="bot-row message-row">
                <Avatar seed="deepgeek" color="#8f8fff" />
                <div className="bubble bot completed" style={{ "--agent-color": "#8f8fff" } as React.CSSProperties}>
                  <span className="speaker">Deepgeek</span>
                  <Markdown text={FOLLOW_UP} onOpen={noOpen} />
                </div>
              </div>
            </div>}
          </div>
          <div className="composer">
            <div className="composer-input">
              <div className="composer-box"><div className="composer-field"><textarea aria-label="Sample message box" placeholder="Message the room" readOnly rows={1} tabIndex={-1} /></div></div>
              <ChipSampleRow style={chips?.style ?? "classic"} details={details} />
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>;
}

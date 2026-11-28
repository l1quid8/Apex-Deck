import { useLayoutEffect, useRef, useState } from "react";
import type { GeneratedCard } from "../../shared/generatedCard.mjs";
import { cardGeometry, nativeCards } from "./generatedCards";

interface Props {
  card: GeneratedCard;
  hostId?: string;
  threadId: string;
  messageId: string;
  onDiscuss(text: string): void;
}

export function PhoneGeneratedCard({ card, hostId, threadId, messageId, onDiscuss }: Props) {
  const slot = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(300);
  const [preview, setPreview] = useState("");
  const [discussion, setDiscussion] = useState("");
  const [failure, setFailure] = useState<"fault" | "unsupported" | null>(null);

  useLayoutEffect(() => {
    const api = nativeCards;
    let alive = true;
    let runId = "";
    let geometryKey = "";
    let suspended = false;
    let timer = 0;
    let observer: MutationObserver | undefined;
    let removeListener: (() => void) | undefined;
    const place = () => {
      if (!alive || suspended || !api || !hostId || !slot.current) return;
      const geometry = cardGeometry(slot.current);
      if (!geometry) { dispose(); return; }
      const key = JSON.stringify(geometry);
      if (key === geometryKey) return;
      geometryKey = key;
      const id = runId || crypto.randomUUID();
      const request = runId ? api.layout({runId: id, ...geometry})
        : api.mount({runId: id, hostId, threadId, messageId, card, ...geometry});
      runId = id;
      void request.catch(error => {
        if (!alive || runId !== id) return;
        if (error?.code === "SUSPENDED") { suspended = true; setPreview(""); dispose(); return; }
        fail();
      });
    };
    const dispose = () => {
      if (runId) {
        void api?.dispose({runId}).catch(() => {});
        if (alive) setDiscussion("");
      }
      runId = "";
      geometryKey = "";
    };
    const fail = () => {
      dispose();
      setDiscussion("");
      setFailure("fault");
    };
    setDiscussion("");
    setPreview("");
    if (api && hostId && !failure) void (async () => {
      if (!(await api.capability()).enabled) { if (alive) setFailure("unsupported"); return; }
      if (!alive) return;
      const listener = await api.addListener("cardEvent", event => {
        if (!alive) return;
        if (event.type === "resumed" && suspended) { suspended = false; place(); return; }
        if (!runId || event.runId !== runId) return;
        if (event.type === "suspended") { suspended = true; setPreview(""); dispose(); return; }
        if (event.type === "preview" && typeof event.image === "string" && event.image.length <= 350000
            && (!event.image || event.image.startsWith("data:image/jpeg;base64,"))) setPreview(event.image);
        if (event.type === "scroll" && Number.isFinite(event.deltaY)) {
          slot.current?.closest(".ph-chat")?.scrollBy(0, Math.max(-innerHeight, Math.min(innerHeight, event.deltaY!)));
        }
        if (event.type === "fault") { fail(); return; }
        if (event.type === "resize" && Number.isFinite(event.height)) setHeight(Math.min(800, Math.max(200, Math.ceil(event.height!))));
        if (event.type === "discuss" && typeof event.text === "string" && event.text.trim() && event.text.length <= 4000) setDiscussion(event.text);
      });
      if (!alive) { void listener.remove(); return; }
      removeListener = () => { void listener.remove(); };
      document.addEventListener("visibilitychange", place);
      document.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
      observer = new MutationObserver(place);
      observer.observe(document.body, { attributes: true, attributeFilter: ["style", "class", "open", "inert", "hidden"], childList: true, subtree: true });
      timer = window.setInterval(place, 200);
      place();
    })().catch(() => { if (alive) fail(); });
    return () => {
      alive = false;
      clearInterval(timer);
      observer?.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("visibilitychange", place);
      document.removeEventListener("scroll", place, true);
      removeListener?.();
      dispose();
    };
  }, [card, hostId, threadId, messageId, failure]);

  return <section className="generated-answer" aria-label={card.title}>
    <h3>{card.title}</h3>
    {!hostId && <p role="status">Waiting for the live chat…</p>}
    {failure ? <>
      <p className="generated-fallback">{card.fallback}</p>
      {hostId && failure === "fault" && <button type="button" onClick={() => setFailure(null)}>Retry interface</button>}
    </> : <div className="generated-slot" style={{ height }} ref={slot} aria-label={card.title}>
      {hostId && preview && <img className="generated-snapshot" src={preview} alt="" draggable={false} />}
    </div>}
    {hostId && discussion && <div className="generated-discuss"><pre>{discussion}</pre>
      <button type="button" onClick={() => { onDiscuss(discussion); setDiscussion(""); }}>Discuss this text</button>
    </div>}
  </section>;
}

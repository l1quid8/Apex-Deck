import { useEffect, useRef, useState } from "react";
import type { PersonalLane } from "./personalAssistant";
import { mentionsPullRequest, type ShipOffer } from "./replyDecision";
import { PullStatus } from "./ReplyDecisionCard";
import "./replyDecision.css";

/** How many of the conversation's newest replies can carry a card; the Mac looks at the same ones. */
const RECENT = 8;

/** Pull request cards for an assistant's conversation, kept current while it is on screen. */
export function useShipOffers(lane: PersonalLane | null) {
  const [offers, setOffers] = useState<ShipOffer[]>([]);
  const [revision, setRevision] = useState(0);
  const read = lane?.shipOffers;
  const assistant = lane?.assistant?.id;
  const replies = (lane?.assistant?.messages ?? []).filter(message => message.role !== "human").slice(-RECENT);
  const named = mentionsPullRequest(replies.map(message => message.text));
  const newest = replies.at(-1)?.id ?? "";
  const live = useRef(read);
  live.current = read;
  const can = !!read;
  useEffect(() => {
    if (!can || !assistant || !named || lane?.offline) { setOffers([]); return; }
    let on = true;
    let timer: number;
    const ask = async () => {
      window.clearTimeout(timer);
      // Nothing left to act on is asked about less often; a hidden window not at all.
      let wait = 15000;
      try {
        if (document.visibilityState !== "hidden") {
          const next = await live.current?.();
          if (on && next) {
            setOffers(next.offers);
            if (!next.offers.some(offer => offer.state === "ready" || offer.state === "waiting" || offer.state === "merging")) wait = 60000;
          }
        }
      } catch {
        // Keep what was last shown; the next look corrects it.
      } finally {
        if (on) timer = window.setTimeout(ask, wait);
      }
    };
    void ask();
    return () => { on = false; window.clearTimeout(timer); };
  }, [can, assistant, named, newest, lane?.offline, revision]);
  return { offers, refresh: () => setRevision(n => n + 1) };
}

export function ShipOfferCard({ offer, lane, refresh }: { offer: ShipOffer; lane: PersonalLane; refresh(): void }) {
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const card = offer.card;
  async function run(work: () => Promise<string>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try { setSaid({ text: await work(), error: false }); }
    catch (error) { setSaid({ text: String(error instanceof Error ? error.message : error), error: true }); }
    finally { refresh(); working.current = false; setBusy(false); }
  }
  if (offer.state === "merged") {
    return <section className="reply-decision ship-offer" aria-label={`Pull request ${offer.pr}`}>
      <p className="context">PR #{offer.pr} · merged</p>
      <strong>{offer.message ?? "Merged into main."}</strong>
    </section>;
  }
  if (!card) return null;
  const cancel = card.kind === "merging";
  const act = () => run(async () => {
    if (cancel) {
      if (!lane.cancelShip || !offer.room || !offer.checkout || !card.head) throw new Error("This merge can no longer be cancelled from here.");
      return (await lane.cancelShip(offer.room, { ...offer.checkout, head: card.head })).message;
    }
    if (!lane.ship || !card.head) throw new Error("Update this machine’s service to ship from here.");
    return (await lane.ship(offer.pr, card.head)).message;
  });
  const label = cancel ? (card.cancellable ? "Cancel" : undefined) : card.primary;
  return <section className="reply-decision ship-offer" aria-label={`Pull request ${offer.pr}`} aria-busy={busy}>
    {card.context && <p className="context">{card.context.includes(`#${offer.pr}`) ? card.context : `PR #${offer.pr} · ${card.context}`}</p>}
    <strong>{card.question}</strong>
    {offer.checkout && card.head && <p className="result">{offer.checkout.repo} · {offer.checkout.branch} · commit {card.head.slice(0, 8)}</p>}
    <PullStatus status={card.status} />
    {card.detail && <details><summary>Show check output</summary><pre>{card.detail}</pre></details>}
    {label && <div className="actions">
      <button className={cancel ? undefined : "primary"} disabled={busy || lane.offline || (!cancel && !!card.blocked)} title={card.blocked} onClick={() => void act()}>{label}</button>
      <small>{card.blocked ? card.blocked : cancel ? "Stops the merge if GitHub hasn’t done it yet" : "0 turns · Deck runs it"}</small>
    </div>}
    {said && <p className={said.error ? "result error" : "result"} role={said.error ? "alert" : "status"}>{said.text}</p>}
  </section>;
}

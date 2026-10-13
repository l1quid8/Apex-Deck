import { Component, useEffect, useMemo, useState, type ReactNode } from "react";

import { AnswerCard, CardFallback } from "./AnswerCard.tsx";
import { cardKey, fingerprint, type AnswerStore } from "./contract.ts";
import { readCard } from "./schema.ts";

interface Props {
  /** The fenced block's text. */
  source: string;
  /** The reply's message number. */
  seq: number;
  /** The bot whose reply it is, by display name. */
  author: string;
  /** From cardVersions over the thread's messages. */
  versions: Map<string, number>;
  /** The thread's saved settings; null while they load, or where they aren't kept. */
  answers: AnswerStore | null;
  /** Show the card without letting it change: the phone, for now. */
  readOnly?: boolean;
  onDiscuss?: (snapshot: string) => void;
  onOpen: (target: string) => void;
}

/** A card in a finished reply, with the settings saved for it; the fallback when the block isn't one. */
export function ThreadCard({ source, seq, author, versions, answers, readOnly = false, onDiscuss, onOpen }: Props) {
  const read = useMemo(() => readCard(source), [source]);
  const print = useMemo(() => fingerprint(source), [source]);
  const key = read.ok ? cardKey(seq, read.card.cardId) : "";
  const [, redraw] = useState(0);
  useEffect(() => (answers && key ? answers.subscribe(key, () => redraw((n) => n + 1)) : undefined), [answers, key]);
  if (!read.ok) return <CardFallback reason={read.reason} source={source} />;
  const store = readOnly ? null : answers;
  return (
    <CardBoundary source={source}>
      <AnswerCard
        card={read.card}
        version={versions.get(key) ?? 1}
        author={author}
        values={answers?.values(key, print) ?? null}
        onChange={store ? (values) => store.set(key, print, values) : undefined}
        onDiscuss={store ? onDiscuss : undefined}
        onOpen={onOpen}
        status={store?.status(key)}
      />
    </CardBoundary>
  );
}

/** A card that throws while it is drawn shows the fallback instead of taking the chat down with it. */
export class CardBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <CardFallback reason="Something in it couldn't be drawn." source={this.props.source} /> : this.props.children;
  }
}

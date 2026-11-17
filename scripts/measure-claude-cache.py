#!/usr/bin/env python3
"""Per-turn Claude prompt-cache measurement from Claude Code session logs.

Reads ~/.claude/projects/<project>/*.jsonl (no API calls, nothing is sent).
Usage rows are de-duplicated by message.id (Claude logs one line per content
block, each carrying the same usage).

Deck turns:   each Deck-written prompt starts a turn within the session.
              Select with --deck-match (substring that must appear in the
              session's first prompt) and --speaker (e.g. "You are Jigga").
              Sessions whose prompt ends with the suggested-replies schema are
              reported separately as "suggest".
Plain turns:  --plain <session-id-prefix> ...; each typed user message starts
              a new turn inside the one resumed session.

Prices are $/MTok, default Opus 5.5 API list with 1-hour cache writes.
Dollar figures are API-equivalent; on a subscription read them as plan usage.

Example:
  python3 -I scripts/measure-claude-cache.py \
    --deck-match pingdotgg/t3code --speaker "You are Jigga" \
    --plain 2c6f97d4 8032d0d8 --csv /tmp/turns.csv
"""
import argparse, csv, glob, json, os, sys

SUGGEST_TAIL = '"prompt": "<full prompt text>"}]'
FULL_VIEW = "\n\n--- Conversation so far ---\n"
FOLLOW_UP = "--- New in the conversation since your last reply ---\n"
REPLY = "--- Your reply ---"
KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
    return ""


def load(path, *, plain=False):
    """Return (entrypoint, first_prompt, turns) where turns is a list of lists of usage dicts."""
    entry, first, turns, seen = None, None, [], {}
    for line in open(path, encoding="utf-8"):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        entry = entry or d.get("entrypoint")
        if d.get("isSidechain"):
            continue
        if d.get("type") == "user":
            txt = text_of(d.get("message", {}).get("content"))
            if not txt.strip():
                continue
            if not plain:
                # Claude records helper completions and synthetic text as user
                # messages too. Identify the exact Deck prompt envelope, including
                # when the first actual prompt follows an internal user event.
                if d.get("isMeta") or REPLY not in txt.splitlines():
                    continue
                if (first is None and FULL_VIEW not in txt) or (first is not None and not txt.startswith(FOLLOW_UP)):
                    continue
            if first is None:
                first = txt
            turns.append([])
        elif d.get("type") == "assistant":
            m = d.get("message", {})
            u, mid = m.get("usage"), m.get("id")
            if not u or not turns:
                continue
            if mid in seen:
                seen[mid].update(u)  # later line wins (final counts)
                continue
            seen[mid] = dict(u)
            turns[-1].append(seen[mid])
    return entry, first or "", [t for t in turns if t]


def cost(u, p):
    return (u["input_tokens"] * p.input + u["cache_creation_input_tokens"] * p.write
            + u["cache_read_input_tokens"] * p.read + u["output_tokens"] * p.output) / 1e6


def summarize(calls):
    tot = {k: sum(c.get(k, 0) or 0 for c in calls) for k in KEYS}
    first = {k: calls[0].get(k, 0) or 0 for k in KEYS}
    return tot, first


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.path.expanduser(
        "~/.claude/projects/-Users-tylercaldwell-Downloads-apex-deck"))
    ap.add_argument("--deck-match", help="substring required in a Deck session's first prompt")
    ap.add_argument("--speaker", default="", help="prefix of the Deck prompt, e.g. 'You are Jigga'")
    ap.add_argument("--exclude", nargs="*", default=[], help="session-id prefixes to skip (e.g. the current turn)")
    ap.add_argument("--plain", nargs="*", default=[], help="plain Claude Code session-id prefixes")
    ap.add_argument("--input", type=float, default=4.0)
    ap.add_argument("--output", type=float, default=20.0)
    ap.add_argument("--write", type=float, default=8.0)
    ap.add_argument("--read", type=float, default=0.20)
    ap.add_argument("--csv")
    p = ap.parse_args()

    rows = []
    for f in sorted(glob.glob(os.path.join(p.project, "*.jsonl")), key=os.path.getmtime):
        sid = os.path.basename(f)[:-6]
        if any(sid.startswith(x) for x in p.exclude):
            continue
        is_plain = any(sid.startswith(x) for x in p.plain)
        if not is_plain and not p.deck_match:
            continue
        if not is_plain:
            with open(f, encoding="utf-8") as fh:
                if p.deck_match not in fh.read():
                    continue
        entry, first, turns = load(f, plain=is_plain)
        if is_plain:
            kind, groups = "plain", turns
        else:
            if entry != "sdk-cli" or not first.startswith(p.speaker) or p.deck_match not in first:
                continue
            kind = "suggest" if first.rstrip().endswith(SUGGEST_TAIL + "\n\n--- Your reply ---") or SUGGEST_TAIL in first[-400:] else "deck"
            groups = turns
        for i, calls in enumerate(groups, 1):
            tot, fst = summarize(calls)
            rows.append(dict(session=sid[:8], kind=kind, turn=i, calls=len(calls),
                             first_read=fst["cache_read_input_tokens"],
                             first_write=fst["cache_creation_input_tokens"],
                             first_cost=round(cost(fst, p), 4),
                             input=tot["input_tokens"], write=tot["cache_creation_input_tokens"],
                             read=tot["cache_read_input_tokens"], out=tot["output_tokens"],
                             cost=round(cost(tot, p), 4)))

    w = csv.DictWriter(sys.stdout, fieldnames=list(rows[0]) if rows else ["none"])
    w.writeheader()
    w.writerows(rows)
    if p.csv:
        with open(p.csv, "w", newline="") as fh:
            cw = csv.DictWriter(fh, fieldnames=w.fieldnames)
            cw.writeheader()
            cw.writerows(rows)

    print("\nTotals by kind (API-equivalent $):", file=sys.stderr)
    for kind in ("deck", "suggest", "plain"):
        rs = [r for r in rows if r["kind"] == kind]
        if not rs:
            continue
        tc = sum(r["cost"] for r in rs)
        fw = sum(r["first_write"] for r in rs)
        print(f"  {kind:8} turns={len(rs):3}  cost=${tc:.2f}  first-call writes={fw:,} tok"
              f" (${fw * p.write / 1e6:.2f})", file=sys.stderr)


if __name__ == "__main__":
    main()

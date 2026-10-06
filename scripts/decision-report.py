#!/usr/bin/env python3
"""Report observations (agreement with Deck is not correctness)."""
import json
import sys
rows = []
with open(sys.argv[1], encoding="utf-8") as source:
    for line in source:
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
usable = [r for r in rows if not r.get("stale") and "result" in r]
agree = sum(set(r.get("deck_targets", [])) == set(r.get("suggested_targets") or []) for r in usable)
print(f"Observations: {len(rows)}; usable: {len(usable)}; stale: {sum(bool(r.get('stale')) for r in rows)}; errors: {sum('error' in r for r in rows)}")
print(f"Agreement with Deck: {agree}/{len(usable)} (does not measure correctness)")
if usable:
    print(f"Mean latency: {sum(r['result']['latency_ms'] for r in usable)/len(usable):.0f} ms")
    costs = [r['result'].get('usage', {}).get('cost') for r in usable if isinstance(r['result'].get('usage'), dict)]
    print(f"Reported cost: ${sum(c for c in costs if isinstance(c, (int, float))):.6f}; unknown costs excluded")

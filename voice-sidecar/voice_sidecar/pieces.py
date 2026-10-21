"""Short CPU synthesis pieces, preserving clauses and avoiding tiny tails."""
SMALL = set('a an the to of and or but for in on at with from by my your our their this that'.split())


def speech_pieces(text, first=8, rest=14):
    words = text.split()
    if not words:
        return []
    if len(words) <= first + 3:
        return [' '.join(words)]
    pieces, start, limit = [], 0, first
    while len(words) - start > limit:
        window = words[start:start + limit]
        clauses = [i for i, word in enumerate(window, 1)
                   if i >= 3 and (word.endswith((',', ';', ':')) or word in ('—', '–', '-'))]
        cut = clauses[-1] if clauses else limit
        if not clauses:
            while cut > 3 and window[cut - 1].lower().strip('.,;:!?') in SMALL:
                cut -= 1
        if len(words) - start - cut < 4:
            break
        pieces.append(' '.join(window[:cut]))
        start += cut
        limit = rest
    pieces.append(' '.join(words[start:]))
    return pieces

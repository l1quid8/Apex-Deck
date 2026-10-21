"""Drop text Whisper invents from noise: no words, looping phrases, an echoed name-hint list, high repetition scores."""
LOOP_REPEATS = 4
MAX_RATIO = 2.4


def words_of(text):
    return [w for w in (w.lower().strip('.,!?;:"\'') for w in text.split()) if w]


def made_up(text, hints, ratios=()):
    if any(r > MAX_RATIO for r in ratios):
        return True
    words = words_of(text)
    if not words:
        return True
    names = {w for h in hints for w in words_of(h)}
    if len(words) >= 3 and names and all(w in names for w in words):
        return True
    for n in range(1, 5):
        for start in range(len(words) - n * LOOP_REPEATS + 1):
            phrase = words[start:start + n]
            if all(words[start + k * n:start + (k + 1) * n] == phrase for k in range(1, LOOP_REPEATS)):
                return True
    return False

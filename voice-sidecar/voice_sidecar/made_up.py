"""Drop text Whisper invents from noise: no words, looping phrases, an echoed name-hint list, high repetition scores,
and its stock sign-off phrases when the audio was doubtful."""
LOOP_REPEATS = 4
MAX_RATIO = 2.4
# Whisper's best-known inventions from near-silence (YouTube sign-offs). Real people say some of these,
# so they are only dropped when the audio was doubtful: low confidence, or heard over the agent's own voice.
STOCK_PHRASES = {
    'you', 'thank you', 'thanks', 'thank you very much', 'thank you so much', 'thanks for watching',
    'thank you for watching', 'thanks for listening', 'thank you for listening', 'please subscribe',
    'like and subscribe', 'see you next time', "i'll see you next time", 'see you in the next video',
    'bye', 'bye bye', 'so', 'okay', 'oh', 'hmm', 'subtitles by the amara.org community',
}
DOUBTFUL_NO_SPEECH = .3
DOUBTFUL_LOGPROB = -.7


def words_of(text):
    return [w for w in (w.lower().strip('.,!?;:"\'') for w in text.split()) if w]


def stock_phrase(text):
    return ' '.join(words_of(text)) in STOCK_PHRASES


def doubtful(no_speech=(), logprobs=()):
    return any(p > DOUBTFUL_NO_SPEECH for p in no_speech) or any(p < DOUBTFUL_LOGPROB for p in logprobs)


def made_up(text, hints, ratios=(), no_speech=(), logprobs=()):
    if any(r > MAX_RATIO for r in ratios):
        return True
    words = words_of(text)
    if not words:
        return True
    if stock_phrase(text) and doubtful(no_speech, logprobs):
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

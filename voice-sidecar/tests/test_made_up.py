import unittest
from voice_sidecar.made_up import made_up, stock_phrase
HINTS = ['Jigga', 'Null', 'deepgeek', 'Muck']
class MadeUpTests(unittest.TestCase):
    def test_looping_name_list_from_a_real_call_is_dropped(self):
        self.assertTrue(made_up('Jigga, Null, deepgeek, ' + 'Null, deepgeek, ' * 30 + 'Null', HINTS))
        self.assertTrue(made_up('Jigga, Null, Pag, ' + 'Null, Pag, ' * 36 + 'Null,', HINTS))
    def test_bare_name_list_is_dropped(self):
        self.assertTrue(made_up('Jigga, Null, deepgeek.', HINTS))
        self.assertTrue(made_up('Muck, Null, deepgeek, Jigga', HINTS))
    def test_punctuation_only_is_dropped(self):
        self.assertTrue(made_up('...', HINTS))
        self.assertTrue(made_up(' . , ', []))
    def test_whisper_repetition_score_drops_text(self):
        self.assertTrue(made_up('Thanks for watching.', HINTS, ratios=[2.9]))
    def test_real_speech_is_kept(self):
        for text in ['Call Null.', 'Null.', 'Hey Null, can you check why the build failed on main?',
                     'No, no, no, that is the wrong file.', 'Ask Jigga and Muck to review it.',
                     'Run the tests again, then run the tests again on the VPS.']:
            self.assertFalse(made_up(text, HINTS, ratios=[1.3]), text)
    def test_names_alone_are_kept_when_there_are_no_hints(self):
        self.assertFalse(made_up('Jigga, Null', []))
    def test_stock_phrase_from_doubtful_audio_is_dropped(self):
        self.assertTrue(made_up('Thank you.', HINTS, ratios=[1.2], no_speech=[.45], logprobs=[-.3]))
        self.assertTrue(made_up('Thanks for watching!', HINTS, ratios=[1.2], no_speech=[.05], logprobs=[-.95]))
        self.assertTrue(made_up('you', HINTS, ratios=[1.0], no_speech=[.6], logprobs=[-.2]))
    def test_clear_stock_phrase_is_kept(self):
        self.assertFalse(made_up('Thank you.', HINTS, ratios=[1.2], no_speech=[.02], logprobs=[-.2]))
        self.assertFalse(made_up('Okay', HINTS, ratios=[1.0], no_speech=[.01], logprobs=[-.15]))
    def test_doubtful_real_speech_is_kept(self):
        self.assertFalse(made_up('Thank you, now run the tests.', HINTS, ratios=[1.2], no_speech=[.5], logprobs=[-.9]))
        self.assertFalse(made_up('Yes, go ahead.', HINTS, ratios=[1.2], no_speech=[.5], logprobs=[-.9]))
    def test_stock_phrase_matching_ignores_case_and_punctuation(self):
        self.assertTrue(stock_phrase(' Thank you. '))
        self.assertTrue(stock_phrase('THANKS FOR WATCHING!'))
        self.assertFalse(stock_phrase('Thank you, Null'))

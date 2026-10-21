import unittest
from voice_sidecar.made_up import made_up
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

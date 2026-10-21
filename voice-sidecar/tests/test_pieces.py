import unittest
from voice_sidecar.pieces import speech_pieces
class PiecesTests(unittest.TestCase):
    def test_short_segments_stay_whole(self):
        self.assertEqual(speech_pieces('Done.'), ['Done.'])
        self.assertEqual(speech_pieces('one two three four five six seven eight nine ten eleven'), ['one two three four five six seven eight nine ten eleven'])
    def test_first_piece_ends_at_a_clause(self):
        self.assertEqual(speech_pieces('I checked the build on main, and the failure comes from the type checker, not the tests.'),
                         ['I checked the build on main,', 'and the failure comes from the type checker, not the tests.'])
    def test_a_hard_cut_never_ends_on_a_small_word(self):
        self.assertEqual(speech_pieces('Please open the settings page and change the default voice to the British one for this agent'),
                         ['Please open the settings page and change', 'the default voice to the British one for this agent'])
    def test_no_tail_under_four_words_and_later_pieces_cap_at_fourteen(self):
        self.assertEqual([len(p.split()) for p in speech_pieces('one two three four five six seven eight nine ten eleven twelve')], [8, 4])
        self.assertEqual([len(p.split()) for p in speech_pieces(' '.join(f'w{i}' for i in range(1, 23)))], [8, 14])

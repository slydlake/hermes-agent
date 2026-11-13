"""A chained voice-chat turn (``voice_turn``) carries a spoken-reply note to the model.

The note rides the same per-turn seam as the HUD / live-voice notes (the user message, never
the frozen system prompt). Without the flag the rendered note stays byte-for-byte unchanged.
"""
from gateway.session_surface import VOICE_TURN_NOTE, surface_note


def test_voice_turn_note_is_appended_for_a_spoken_turn():
    assert surface_note({'voice_turn': True}) == VOICE_TURN_NOTE


def test_voice_turn_survives_admission_and_restore_and_reaches_the_note():
    from gateway.session_surface import admit_surface, restore_surface
    committed = admit_surface({'voice_turn': True})['surface_v1']
    assert committed == {'voice_turn': True}
    assert restore_surface(committed) == committed
    assert surface_note(committed) == VOICE_TURN_NOTE


def test_live_delegation_with_voice_turn_keeps_the_delegation_note_first():
    from tools.voice_live import voice_live_turn_note
    committed = {'surface': 'voice-live', 'voice_context': 'User: hi', 'voice_turn': True}
    assert surface_note(committed) == voice_live_turn_note('User: hi') + '\n\n' + VOICE_TURN_NOTE


def test_voice_turn_note_teaches_the_spoken_reply_rules():
    # The spoken contract: the user's language, no read-out identifiers, and the one-sentence
    # preamble before the first tool call.
    assert 'German' in VOICE_TURN_NOTE
    assert 'markdown' in VOICE_TURN_NOTE
    assert 'IP addresses' in VOICE_TURN_NOTE
    assert 'Ich schau mal kurz nach.' in VOICE_TURN_NOTE


def test_barge_in_note_precedes_the_voice_turn_note():
    from tools.tts_streaming import SPEECH_INTERRUPTED_NOTE
    assert surface_note({'voice_turn': True, 'interrupted': True}) == (
        SPEECH_INTERRUPTED_NOTE + '\n\n' + VOICE_TURN_NOTE)


def test_turns_without_voice_turn_render_byte_identical_notes():
    from agent.prompt_builder import hud_surface_note
    from tools.voice_live import VOICE_LIVE_TURN_NOTE, voice_live_turn_note
    assert surface_note({}) == ''
    assert surface_note({'voice_turn': False}) == ''
    assert surface_note({'surface': 'voice-live'}) == VOICE_LIVE_TURN_NOTE
    assert surface_note({'surface': 'voice-live', 'voice_context': 'User: hi'}) == voice_live_turn_note('User: hi')
    assert surface_note({'surface': 'hud'}, {'read_window_below'}) == hud_surface_note({'read_window_below'})
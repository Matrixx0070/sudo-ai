#!/usr/bin/env python3
"""Deterministic tests for grok_turn_vad.AdaptiveTurnSegmenter — no I/O, no clock.
Run: python3 scripts/grok-web/grok_turn_vad_test.py  (exit 0 = all pass)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grok_turn_vad import AdaptiveTurnSegmenter

_p = _f = 0


def check(name, cond):
    global _p, _f
    if cond:
        _p += 1; print("PASS", name)
    else:
        _f += 1; print("FAIL", name)


def run(seg, samples, dt=0.1):
    """samples: list of rms; feeds at index = i*100, t = i*dt. Returns events."""
    events = []
    for i, r in enumerate(samples):
        ev = seg.feed(r, i * 100, i * dt)
        if ev:
            events.append((ev, i))
    return events


# 1) Low noise floor (~0): silence -> speech -> silence => onset then end.
seg = AdaptiveTurnSegmenter(hangover_s=0.5, min_speech_s=0.2)
samples = [0] * 5 + [1500] * 8 + [0] * 8      # speech spans feeds 5..12, silence from 13
evs = run(seg, samples)
check("low-floor onset detected", any(e[0] == "onset" for e in evs))
check("low-floor end detected", any(e[0] == "end" for e in evs))
onset_i = next(e[1] for e in evs if e[0] == "onset")
check("low-floor onset near speech start (feed 5-7)", 5 <= onset_i <= 7)
check("low-floor end_index ~ last loud frame", seg.end_index == 12 * 100)

# 2) High comfort-noise floor (~300): fixed 150 threshold would misfire; adaptive adapts.
seg2 = AdaptiveTurnSegmenter(hangover_s=0.5, min_speech_s=0.2)
samples2 = [300] * 8 + [1600] * 8 + [300] * 8
evs2 = run(seg2, samples2)
check("high-floor tracked (~300)", 250 <= (seg2.floor or 0) <= 350)
check("high-floor enter>exit (hysteresis)", seg2.enter_threshold > seg2.exit_threshold)
check("high-floor onset detected (300 idle NOT treated as speech)", any(e[0] == "onset" for e in evs2))
check("high-floor end detected", any(e[0] == "end" for e in evs2))

# 3) Blip rejection: a single loud frame shorter than min_speech => no onset.
seg3 = AdaptiveTurnSegmenter(hangover_s=0.5, min_speech_s=0.3)
run(seg3, [0] * 4 + [1500] * 1 + [0] * 8)
check("blip does not trigger onset", seg3.onset_index is None)

# 4) Hysteresis: mid-reply dip below ENTER but above EXIT keeps speaking.
seg4 = AdaptiveTurnSegmenter(hangover_s=0.5, min_speech_s=0.2, enter_margin=100, exit_margin=60)
# floor ~300 -> enter=1300, exit=810. dip to 900 (below enter, above exit) must NOT end the turn.
samples4 = [300] * 6 + [1600] * 4 + [900] * 3 + [1600] * 3 + [300] * 8
evs4 = run(seg4, samples4)
ends = [e[1] for e in evs4 if e[0] == "end"]
check("hysteresis: no end during the 900 dip", all(i > 16 for i in ends))  # dip is feeds 10-12
check("hysteresis: end eventually detected", len(ends) == 1)

print(f"\n{_p} passed, {_f} failed")
sys.exit(1 if _f else 0)

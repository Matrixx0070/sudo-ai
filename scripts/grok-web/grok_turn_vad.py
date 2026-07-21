#!/usr/bin/env python3
"""AdaptiveTurnSegmenter — adaptive end-of-turn detection for the grok LiveKit
voice agent.

The grok agent's audio track genuinely falls to a near-constant NOISE FLOOR
between replies and rises well above it while speaking, but the ABSOLUTE floor is
not guaranteed stable across grok deploys. So instead of a fixed RMS threshold we
track the noise floor with an EMA (updated only during confident silence) and set
speech ENTER/EXIT thresholds RELATIVE to it, with hysteresis (enter > exit) so a
brief dip mid-word doesn't end the turn.

Pure + deterministic (no I/O, no clock): the caller feeds `(rms, index, t)` per
poll — `rms` of the trailing window, `index` = bytes captured so far, `t` =
elapsed seconds — and reads `onset_index` / `end_index`. Unit-tested in
grok_turn_vad_test.py.
"""


class AdaptiveTurnSegmenter:
    WAIT_ONSET = "wait_onset"
    SPEAKING = "speaking"
    ENDED = "ended"

    def __init__(
        self,
        hangover_s: float = 1.0,      # trailing silence that ends the reply
        min_speech_s: float = 0.2,    # sustained loud audio to confirm onset (ignore blips)
        enter_mult: float = 4.0,      # enter-speech threshold = floor*enter_mult + enter_margin
        enter_margin: float = 100.0,  # absolute floor so a 0-floor still needs real energy
        exit_mult: float = 2.5,       # exit-speech (silence) threshold, kept < enter for hysteresis
        exit_margin: float = 60.0,
        floor_alpha: float = 0.1,     # EMA weight for tracking the noise floor during silence
    ) -> None:
        self.hangover_s = hangover_s
        self.min_speech_s = min_speech_s
        self.enter_mult = enter_mult
        self.enter_margin = enter_margin
        self.exit_mult = exit_mult
        self.exit_margin = exit_margin
        self.floor_alpha = floor_alpha

        self.state = self.WAIT_ONSET
        self.floor: float | None = None
        self.onset_index: int | None = None
        self.end_index: int | None = None
        self._speech_start_t: float | None = None
        self._onset_candidate_index: int | None = None
        self._last_voiced_index: int = 0
        self._silent_since_t: float | None = None

    @property
    def enter_threshold(self) -> float:
        f = self.floor or 0.0
        return f * self.enter_mult + self.enter_margin

    @property
    def exit_threshold(self) -> float:
        f = self.floor or 0.0
        return f * self.exit_mult + self.exit_margin

    def feed(self, rms: float, index: int, t: float):
        """Advance the state machine one poll. Returns 'onset' | 'end' | None."""
        if self.floor is None:
            self.floor = rms

        if self.state == self.WAIT_ONSET:
            if rms > self.enter_threshold:
                if self._speech_start_t is None:
                    self._speech_start_t = t
                    self._onset_candidate_index = index
                elif t - self._speech_start_t >= self.min_speech_s:
                    self.state = self.SPEAKING
                    self.onset_index = self._onset_candidate_index
                    self._last_voiced_index = index
                    self._silent_since_t = None
                    return "onset"
            else:
                # confident silence — track the noise floor and cancel any candidate
                self._speech_start_t = None
                self._onset_candidate_index = None
                self.floor = (1 - self.floor_alpha) * self.floor + self.floor_alpha * rms
            return None

        if self.state == self.SPEAKING:
            if rms > self.exit_threshold:
                self._last_voiced_index = index
                self._silent_since_t = None
            else:
                if self._silent_since_t is None:
                    self._silent_since_t = t
                elif t - self._silent_since_t >= self.hangover_s:
                    self.state = self.ENDED
                    self.end_index = self._last_voiced_index
                    return "end"
            return None

        return None

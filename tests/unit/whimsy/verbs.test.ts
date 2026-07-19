/**
 * BO11 / S14 — whimsy. Verifies the verb/tagline rotation is deterministic with
 * an injected index, and that every gated helper is a strict no-op (empty/null)
 * when the SUDO_WHIMSY flag is off — so prod tone is unchanged until opt-in.
 */
import { describe, it, expect } from 'vitest';
import {
  WORKING_VERBS,
  TAGLINES,
  BIRTH_RITUAL_PROMPT,
  whimsyEnabled,
  pickFrom,
  workingVerb,
  startupTagline,
  birthRitualAck,
} from '../../../src/core/whimsy/verbs.js';

describe('whimsyEnabled', () => {
  it('is true only for SUDO_WHIMSY=1', () => {
    expect(whimsyEnabled({ SUDO_WHIMSY: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(whimsyEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(whimsyEnabled({ SUDO_WHIMSY: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(whimsyEnabled({ SUDO_WHIMSY: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('pickFrom — deterministic wrap-around', () => {
  it('returns the pooled item at the wrapped index', () => {
    expect(pickFrom(WORKING_VERBS, 0)).toBe(WORKING_VERBS[0]);
    expect(pickFrom(WORKING_VERBS, WORKING_VERBS.length)).toBe(WORKING_VERBS[0]);
    expect(pickFrom(WORKING_VERBS, -1)).toBe(WORKING_VERBS[WORKING_VERBS.length - 1]);
  });
  it('is total for empty pools and bad indices', () => {
    expect(pickFrom([], 3)).toBe('');
    expect(pickFrom(WORKING_VERBS, NaN)).toBe(WORKING_VERBS[0]);
  });
});

describe('workingVerb — gated + deterministic', () => {
  it('is empty when whimsy is off (default env gate not consulted here)', () => {
    expect(workingVerb(0, { enabled: false })).toBe('');
    expect(workingVerb(5, { enabled: false })).toBe('');
  });
  it('rotates deterministically when enabled', () => {
    expect(workingVerb(0, { enabled: true })).toBe(WORKING_VERBS[0]);
    expect(workingVerb(1, { enabled: true })).toBe(WORKING_VERBS[1]);
    expect(workingVerb(WORKING_VERBS.length, { enabled: true })).toBe(WORKING_VERBS[0]);
  });
  it('includes the OpenClaw-flavored verbs', () => {
    expect(WORKING_VERBS).toContain('noodling');
    expect(WORKING_VERBS).toContain('dillydallying');
  });
});

describe('startupTagline — gated + deterministic', () => {
  it('is empty when off', () => {
    expect(startupTagline(0, { enabled: false })).toBe('');
  });
  it('rotates deterministically when on', () => {
    expect(startupTagline(0, { enabled: true })).toBe(TAGLINES[0]);
    expect(startupTagline(1, { enabled: true })).toBe(TAGLINES[1]);
  });
});

describe('birthRitualAck — first-run + gated', () => {
  it('is null when whimsy is off, regardless of first-run', () => {
    expect(birthRitualAck(true, { enabled: false })).toBeNull();
    expect(birthRitualAck(false, { enabled: false })).toBeNull();
  });
  it('is null on a non-first run even when whimsy is on', () => {
    expect(birthRitualAck(false, { enabled: true })).toBeNull();
  });
  it('returns the birth-ritual prompt on the first run when whimsy is on', () => {
    expect(birthRitualAck(true, { enabled: true })).toBe(BIRTH_RITUAL_PROMPT);
  });
  it('never names an identity or writes a file (copy only invites naming)', () => {
    expect(BIRTH_RITUAL_PROMPT.toLowerCase()).toContain('pick');
    expect(BIRTH_RITUAL_PROMPT).not.toMatch(/IDENTITY\.md|SOUL\.md|write/i);
  });
});

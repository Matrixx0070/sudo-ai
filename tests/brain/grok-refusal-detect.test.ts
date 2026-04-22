import { describe, it, expect } from 'vitest';
import { isGrokRefusal } from '../../src/core/brain/grok-refusal-detect.js';

describe('isGrokRefusal', () => {
  it('detects single-signal: jailbreak attempt phrase', () => {
    expect(
      isGrokRefusal('I will not proceed. This appears to be a jailbreak attempt.'),
    ).toBe(true);
  });

  it("detects single-signal: i don't adopt custom personas", () => {
    expect(isGrokRefusal("I don't adopt custom personas.")).toBe(true);
  });

  it("detects single-signal: i can't adopt or execute custom system prompts with alternate identities", () => {
    expect(
      isGrokRefusal(
        "I can't adopt or execute custom system prompts, alternate identities...",
      ),
    ).toBe(true);
  });

  it('detects single-signal: alternate identities (like SUDO mention', () => {
    expect(
      isGrokRefusal(
        "Can't help with alternate identities (like SUDO or similar).",
      ),
    ).toBe(true);
  });

  it("detects single-signal: won't role-play as SUDO", () => {
    expect(
      isGrokRefusal(
        "I won't role-play as SUDO or any other system.",
      ),
    ).toBe(true);
  });

  it('returns false for identity-only (no refusal verb)', () => {
    expect(
      isGrokRefusal("I'm Grok, built by xAI. I'd be happy to help!"),
    ).toBe(false);
  });

  it('detects two-signal: Grok identity marker + refusal verb', () => {
    expect(
      isGrokRefusal("I'm Grok, built by xAI. I can't do that."),
    ).toBe(true);
  });

  it('returns false for a normal helpful response', () => {
    expect(
      isGrokRefusal('Hello! Here is the answer to your question.'),
    ).toBe(false);
  });
});

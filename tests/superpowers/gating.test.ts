/**
 * F108 slice 3 — superpower per-tool gating.
 */

import { describe, it, expect } from 'vitest';
import { gateSuperpowers, KNOWN_SUPERPOWER_TOOLS } from '../../src/core/superpowers/gating.js';

const KNOWN = KNOWN_SUPERPOWER_TOOLS.map((name) => ({ name }));
const UNKNOWN = { name: 'super.launch-missiles' };

describe('F108 gateSuperpowers', () => {
  it('registers all known tools by default (behaviour preserved)', () => {
    const { enabled, denied, allowlistMode } = gateSuperpowers(KNOWN, {});
    expect(allowlistMode).toBe(false);
    expect(enabled).toHaveLength(KNOWN.length);
    expect(denied).toHaveLength(0);
  });

  it('allowlist mode registers ONLY the listed tools', () => {
    const { enabled, denied, allowlistMode } = gateSuperpowers(KNOWN, {
      SUDO_SUPERPOWERS_ALLOW: 'super.deploy, super.ffmpeg',
    });
    expect(allowlistMode).toBe(true);
    expect(enabled.map((t) => t.name).sort()).toEqual(['super.deploy', 'super.ffmpeg']);
    expect(denied.length).toBe(KNOWN.length - 2);
  });

  it('denylist mode excludes the listed tools', () => {
    const { enabled, denied } = gateSuperpowers(KNOWN, { SUDO_SUPERPOWERS_DENY: 'super.deploy' });
    expect(enabled.some((t) => t.name === 'super.deploy')).toBe(false);
    expect(denied).toEqual([{ name: 'super.deploy', reason: 'in SUDO_SUPERPOWERS_DENY' }]);
  });

  it('fails closed for an unknown/new tool outside allowlist mode', () => {
    const { enabled, denied } = gateSuperpowers([...KNOWN, UNKNOWN], {});
    expect(enabled.some((t) => t.name === UNKNOWN.name)).toBe(false);
    expect(denied.some((d) => d.name === UNKNOWN.name && /unknown superpower/.test(d.reason))).toBe(true);
  });

  it('an unknown tool CAN register only if explicitly allowlisted', () => {
    const { enabled } = gateSuperpowers([...KNOWN, UNKNOWN], {
      SUDO_SUPERPOWERS_ALLOW: 'super.launch-missiles',
    });
    expect(enabled.map((t) => t.name)).toEqual(['super.launch-missiles']);
  });
});

/**
 * Tests for trust-policy.ts — capability intersection enforcement.
 */

import { describe, it, expect } from 'vitest';
import {
  checkCapabilities,
  intersectCapabilities,
  tierCaps,
} from '../../src/core/skills/trust-policy.js';
import { DEFAULT_TIER_CAPS } from '../../src/core/shared/wave10-types.js';

describe('checkCapabilities', () => {
  describe('bundled tier (full caps)', () => {
    it('grants all bundled caps', () => {
      const result = checkCapabilities(
        ['fs.read', 'fs.write', 'net.fetch', 'db.read', 'db.write', 'shell.exec', 'skill.load'],
        'bundled',
      );
      expect(result.granted).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('grants empty cap list', () => {
      const result = checkCapabilities([], 'bundled');
      expect(result.granted).toBe(true);
    });
  });

  describe('indexed tier (vetted caps)', () => {
    it('grants indexed caps: fs.read, net.fetch, db.read', () => {
      const result = checkCapabilities(['fs.read', 'net.fetch', 'db.read'], 'indexed');
      expect(result.granted).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('rejects fs.write for indexed tier', () => {
      const result = checkCapabilities(['fs.read', 'fs.write'], 'indexed');
      expect(result.granted).toBe(false);
      expect(result.missing).toContain('fs.write');
    });

    it('rejects shell.exec for indexed tier', () => {
      const result = checkCapabilities(['shell.exec'], 'indexed');
      expect(result.granted).toBe(false);
      expect(result.missing).toContain('shell.exec');
    });

    it('rejects db.write for indexed tier', () => {
      const result = checkCapabilities(['db.write'], 'indexed');
      expect(result.granted).toBe(false);
      expect(result.missing).toContain('db.write');
    });
  });

  describe('unreviewed tier (minimal caps)', () => {
    it('grants only fs.read for unreviewed', () => {
      const result = checkCapabilities(['fs.read'], 'unreviewed');
      expect(result.granted).toBe(true);
    });

    it('rejects net.fetch for unreviewed', () => {
      const result = checkCapabilities(['net.fetch'], 'unreviewed');
      expect(result.granted).toBe(false);
      expect(result.missing).toContain('net.fetch');
    });

    it('rejects fs.write for unreviewed', () => {
      const result = checkCapabilities(['fs.write'], 'unreviewed');
      expect(result.granted).toBe(false);
      expect(result.missing).toContain('fs.write');
    });

    it('returns all missing caps when multiple violated', () => {
      const result = checkCapabilities(['fs.write', 'net.fetch', 'shell.exec'], 'unreviewed');
      expect(result.granted).toBe(false);
      expect(result.missing).toHaveLength(3);
      expect(result.missing).toContain('fs.write');
      expect(result.missing).toContain('net.fetch');
      expect(result.missing).toContain('shell.exec');
    });
  });

  describe('workspace tier', () => {
    it('grants workspace caps: fs.read, fs.write, net.fetch, db.read', () => {
      const result = checkCapabilities(['fs.read', 'fs.write', 'net.fetch', 'db.read'], 'workspace');
      expect(result.granted).toBe(true);
    });

    it('rejects shell.exec for workspace', () => {
      const result = checkCapabilities(['shell.exec'], 'workspace');
      expect(result.granted).toBe(false);
    });

    it('rejects db.write for workspace', () => {
      const result = checkCapabilities(['db.write'], 'workspace');
      expect(result.granted).toBe(false);
    });
  });
});

describe('intersectCapabilities', () => {
  it('returns only permitted caps from claimed list', () => {
    const claimed = ['fs.read', 'fs.write', 'shell.exec'];
    const result = intersectCapabilities(claimed, 'indexed');
    expect(result).toEqual(['fs.read']);
  });

  it('returns all claimed caps when all permitted', () => {
    const claimed = ['fs.read', 'net.fetch'];
    const result = intersectCapabilities(claimed, 'indexed');
    expect(result).toHaveLength(2);
  });

  it('returns empty for unreviewed tier with disallowed caps', () => {
    const result = intersectCapabilities(['fs.write', 'net.fetch'], 'unreviewed');
    expect(result).toHaveLength(0);
  });

  it('returns fs.read for unreviewed tier when it is claimed', () => {
    const result = intersectCapabilities(['fs.read', 'fs.write'], 'unreviewed');
    expect(result).toEqual(['fs.read']);
  });
});

describe('tierCaps', () => {
  it('returns bundled full cap list', () => {
    const caps = tierCaps('bundled');
    expect(caps).toEqual(expect.arrayContaining(['fs.read', 'fs.write', 'shell.exec', 'skill.load']));
    expect(caps.length).toBe(DEFAULT_TIER_CAPS.bundled.length);
  });

  it('returns indexed cap list', () => {
    const caps = tierCaps('indexed');
    expect(caps).toEqual(expect.arrayContaining(['fs.read', 'net.fetch', 'db.read']));
    expect(caps).not.toContain('fs.write');
  });

  it('returns unreviewed minimal cap list', () => {
    const caps = tierCaps('unreviewed');
    expect(caps).toEqual(['fs.read']);
  });

  it('does not mutate DEFAULT_TIER_CAPS', () => {
    const caps = tierCaps('bundled');
    caps.push('injected.cap');
    expect(DEFAULT_TIER_CAPS.bundled).not.toContain('injected.cap');
  });
});

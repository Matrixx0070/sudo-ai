/**
 * Registry tests for social and comms tools cleanup verification.
 * Asserts that deleted tools are gone and retained tools are present
 * with the correct enum values.
 *
 * Updated Wave 10: COMMS_TOOLS now contains 11 entries (6 original + 5 Wave 10 connectors).
 */

import { describe, it, expect } from 'vitest';
import { COMMS_TOOLS } from '../../../../src/core/tools/builtin/comms/index.js';
import { multiPostTool, schedulePostTool } from '../../../../src/core/tools/builtin/social/platform-tools.js';
import { twitterManagerTool } from '../../../../src/core/tools/builtin/social/twitter-tools.js';

// We import specific tools to verify their presence without triggering
// the full dispatcher singleton (schedulePostTool.execute would fail without it).

describe('comms/index.ts — COMMS_TOOLS registry', () => {
  it('COMMS_TOOLS has exactly 11 entries (6 original + 5 Wave 10 connectors)', () => {
    expect(COMMS_TOOLS).toHaveLength(11);
  });

  it('COMMS_TOOLS contains all 6 original tools', () => {
    const names = COMMS_TOOLS.map((t) => t.name);
    expect(names).toContain('comms.email');
    expect(names).toContain('comms.slack');
    expect(names).toContain('comms.sms');
    expect(names).toContain('comms.webhook');
    expect(names).toContain('comms.notify');
    expect(names).toContain('comms.voice');
  });

  it('COMMS_TOOLS contains all 5 Wave 10 connector tools', () => {
    const names = COMMS_TOOLS.map((t) => t.name);
    expect(names).toContain('comms.gmail');
    expect(names).toContain('comms.gcalendar');
    expect(names).toContain('comms.github-notify');
    expect(names).toContain('comms.slack-rt');
    expect(names).toContain('comms.imessage');
  });

  it('COMMS_TOOLS does NOT contain comms.twitter-post', () => {
    const names = COMMS_TOOLS.map((t) => t.name);
    expect(names).not.toContain('comms.twitter-post');
  });

  it('COMMS_TOOLS does NOT contain comms.social-post', () => {
    const names = COMMS_TOOLS.map((t) => t.name);
    expect(names).not.toContain('comms.social-post');
  });
});

describe('social/platform-tools.ts — multiPostTool enum', () => {
  it('social.multi-post has correct name', () => {
    expect(multiPostTool.name).toBe('social.multi-post');
  });

  it('platforms parameter enum is exactly ["twitter", "mastodon", "schedule"]', () => {
    const platformsParam = multiPostTool.parameters['platforms'] as {
      items?: { enum?: string[] };
    };
    const enumValues = platformsParam?.items?.enum ?? [];
    expect(enumValues).toEqual(['twitter', 'mastodon', 'schedule']);
  });

  it('platforms enum does NOT include "youtube-community"', () => {
    const platformsParam = multiPostTool.parameters['platforms'] as {
      items?: { enum?: string[] };
    };
    const enumValues = platformsParam?.items?.enum ?? [];
    expect(enumValues).not.toContain('youtube-community');
  });

  it('platforms enum does NOT include "moltbook"', () => {
    const platformsParam = multiPostTool.parameters['platforms'] as {
      items?: { enum?: string[] };
    };
    const enumValues = platformsParam?.items?.enum ?? [];
    expect(enumValues).not.toContain('moltbook');
  });

  it('platforms enum includes "mastodon"', () => {
    const platformsParam = multiPostTool.parameters['platforms'] as {
      items?: { enum?: string[] };
    };
    const enumValues = platformsParam?.items?.enum ?? [];
    expect(enumValues).toContain('mastodon');
  });
});

describe('social/platform-tools.ts — schedulePostTool presence', () => {
  it('social.schedule-post is still present with correct name', () => {
    expect(schedulePostTool.name).toBe('social.schedule-post');
  });

  it('schedulePostTool has create, list, cancel actions in its enum', () => {
    const actionParam = schedulePostTool.parameters['action'] as {
      enum?: string[];
    };
    expect(actionParam?.enum).toEqual(expect.arrayContaining(['create', 'list', 'cancel']));
  });
});

describe('social/twitter-tools.ts — twitterManagerTool still present', () => {
  it('social.twitter-manager is still present with correct name', () => {
    expect(twitterManagerTool.name).toBe('social.twitter-manager');
  });

  it('twitterManagerTool has an execute function', () => {
    expect(typeof twitterManagerTool.execute).toBe('function');
  });
});

describe('social tools — no banned platform references', () => {
  it('multiPostTool description does not reference moltbook or youtube-community', () => {
    const desc = multiPostTool.description.toLowerCase();
    expect(desc).not.toContain('moltbook');
    expect(desc).not.toContain('youtube-community');
  });

  it('multiPostTool JSON representation does not contain moltbook', () => {
    const serialized = JSON.stringify(multiPostTool);
    expect(serialized).not.toContain('moltbook');
  });

  it('multiPostTool JSON representation does not contain youtube-community', () => {
    const serialized = JSON.stringify(multiPostTool);
    expect(serialized).not.toContain('youtube-community');
  });

  it('schedulePostTool JSON representation does not contain moltbook', () => {
    const serialized = JSON.stringify(schedulePostTool);
    expect(serialized).not.toContain('moltbook');
  });
});

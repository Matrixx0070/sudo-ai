/**
 * @file tests/embodiment/stream-plan.test.ts
 * @description H4 honesty fix — buildStreamPlan's checklist is a to-do list;
 * it must not assert past-tense completed actions that never happened.
 */

import { describe, it, expect } from 'vitest';
import { buildStreamPlan } from '../../src/core/embodiment/avatar-stream.js';

describe('buildStreamPlan checklist honesty', () => {
  const plan = () =>
    buildStreamPlan(
      { title: 'Launch Day', platform: 'youtube', avatarId: 'a1', duration: 60, topics: ['intro'] },
      'Nova',
    );

  it('SP-1: checklist items are to-dos, not past-tense completion claims', () => {
    const { checklist } = plan();
    const completionClaims = [
      /loaded/i,
      /configured:/i,
      /connected:/i,
      /verified$/i,
      /queued$/i,
      /reviewed$/i,
      /prepared$/i,
      /uploaded$/i,
      /passed/i,
      /running$/i,
    ];
    for (const item of checklist) {
      for (const claim of completionClaims) {
        expect(item, `checklist item asserts completion: "${item}"`).not.toMatch(claim);
      }
    }
  });

  it('SP-2: checklist keeps its actionable content in imperative form', () => {
    const { checklist } = plan();
    expect(checklist).toContain('Upload thumbnail');
    expect(checklist).toContain('Run stream health check (bitrate / keyframe interval)');
    expect(checklist.some((c) => c.startsWith('Load avatar "Nova"'))).toBe(true);
    expect(checklist.some((c) => c.includes('youtube'))).toBe(true);
  });

  it('SP-3: plan document still carries title, platform and segments', () => {
    const { plan: doc } = plan();
    expect(doc).toContain('Stream Plan: "Launch Day"');
    expect(doc).toContain('youtube');
    expect(doc).toContain('Segment Breakdown:');
  });
});

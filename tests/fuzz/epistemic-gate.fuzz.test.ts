/**
 * @file tests/fuzz/epistemic-gate.fuzz.test.ts
 * @description Wave 8F: Fuzz tests for EpistemicGate pure functions.
 *
 * Tests:
 *   EG-1  CONJECTURE + MEDIUM → REPLAN (Wave 6F invariant)
 *   EG-2  CONJECTURE + HIGH → REPLAN
 *   EG-3  CONJECTURE + CRITICAL → REPLAN
 *   EG-4  CONJECTURE + LOW → PROCEED (no block)
 *   EG-5  UNKNOWN + HIGH → REPLAN
 *   EG-6  UNKNOWN + CRITICAL → REPLAN
 *   EG-7  UNKNOWN + LOW → UNCERTAIN_RESPONSE
 *   EG-8  UNKNOWN + MEDIUM → UNCERTAIN_RESPONSE
 *   EG-9  CERTAIN + any → PROCEED
 *   EG-10 PROBABLE + any → PROCEED
 *   EG-11 Random rationale texts do not throw from classifyRationale
 *   EG-12 Malformed/empty rationale → PROBABLE (model silence ≠ explicit uncertainty)
 *   EG-13 Conjecture keywords reliably classified
 *   EG-14 Unknown keywords reliably classified
 *   EG-15 Probable keywords classified as PROBABLE
 *   EG-16 Certain text (no hedge markers) → CERTAIN
 *   EG-17 classifyImpact: delete/drop/exec → CRITICAL
 *   EG-18 classifyImpact: write/create/update → HIGH
 *   EG-19 classifyImpact: send/query/fetch → MEDIUM
 *   EG-20 gateToolCall: all 16 (tag × impact) combos produce valid decisions
 *   EG-21 buildConjectureCommitError truncates rationale to 200 chars
 *   EG-22 EpistemicGate.evaluate fail-open on null rationale
 *   EG-23 EpistemicGate.evaluate with no DB never throws
 *   EG-24 Random mixed tag rationale text — no throws
 *   EG-25 Rationale with ALL hedge types — first-match order respected
 *   EG-26 gateToolCall with invalid/unknown tag falls through to PROCEED
 *   EG-27 listDecisions without DB returns empty array
 *   EG-28 getStats without DB returns zeroed stats
 */

import { describe, it, expect } from 'vitest';
import {
  classifyRationale,
  classifyImpact,
  gateToolCall,
  buildConjectureCommitError,
  buildUncertaintyResponse,
  EpistemicGate,
  type EpistemicTag,
  type ImpactLevel,
  type GateDecision,
} from '../../src/core/cognition/epistemic-gate.js';

// ---------------------------------------------------------------------------
// Seeded RNG for deterministic fuzz
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0xCAFEBABE;

function randomText(rand: () => number, length: number): string {
  const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'I', 'think',
    'probably', 'perhaps', 'maybe', 'certainly', 'definitely', 'it', 'appears', 'seems', 'based',
    'on', 'evidence', 'suggests', 'unknown', 'cannot', 'determine', 'believe', 'assume', 'guess'];
  const parts: string[] = [];
  for (let i = 0; i < length; i++) {
    parts.push(words[Math.floor(rand() * words.length)]!);
  }
  return parts.join(' ');
}

const TAGS: EpistemicTag[] = ['CERTAIN', 'PROBABLE', 'CONJECTURE', 'UNKNOWN'];
const IMPACTS: ImpactLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const VALID_DECISIONS: GateDecision[] = ['PROCEED', 'REPLAN', 'UNCERTAIN_RESPONSE'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EpistemicGate fuzz', () => {
  // -------------------------------------------------------------------------
  // EG-1: CONJECTURE + MEDIUM → REPLAN (Wave 6F invariant)
  // -------------------------------------------------------------------------
  it('EG-1: CONJECTURE + MEDIUM → REPLAN (Wave 6F invariant)', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'MEDIUM' });
    expect(result.decision).toBe('REPLAN');
    expect(result.reason).toMatch(/conjecture/i);
  });

  // -------------------------------------------------------------------------
  // EG-2: CONJECTURE + HIGH → REPLAN
  // -------------------------------------------------------------------------
  it('EG-2: CONJECTURE + HIGH → REPLAN', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'HIGH' });
    expect(result.decision).toBe('REPLAN');
  });

  // -------------------------------------------------------------------------
  // EG-3: CONJECTURE + CRITICAL → REPLAN
  // -------------------------------------------------------------------------
  it('EG-3: CONJECTURE + CRITICAL → REPLAN', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'CRITICAL' });
    expect(result.decision).toBe('REPLAN');
  });

  // -------------------------------------------------------------------------
  // EG-4: CONJECTURE + LOW → PROCEED (not blocked)
  // -------------------------------------------------------------------------
  it('EG-4: CONJECTURE + LOW → PROCEED', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'LOW' });
    expect(result.decision).toBe('PROCEED');
  });

  // -------------------------------------------------------------------------
  // EG-5: UNKNOWN + HIGH → REPLAN
  // -------------------------------------------------------------------------
  it('EG-5: UNKNOWN + HIGH → REPLAN', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'HIGH' });
    expect(result.decision).toBe('REPLAN');
  });

  // -------------------------------------------------------------------------
  // EG-6: UNKNOWN + CRITICAL → REPLAN
  // -------------------------------------------------------------------------
  it('EG-6: UNKNOWN + CRITICAL → REPLAN', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'CRITICAL' });
    expect(result.decision).toBe('REPLAN');
  });

  // -------------------------------------------------------------------------
  // EG-7: UNKNOWN + LOW → UNCERTAIN_RESPONSE
  // -------------------------------------------------------------------------
  it('EG-7: UNKNOWN + LOW → UNCERTAIN_RESPONSE', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'LOW' });
    expect(result.decision).toBe('UNCERTAIN_RESPONSE');
  });

  // -------------------------------------------------------------------------
  // EG-8: UNKNOWN + MEDIUM → UNCERTAIN_RESPONSE
  // -------------------------------------------------------------------------
  it('EG-8: UNKNOWN + MEDIUM → UNCERTAIN_RESPONSE', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'MEDIUM' });
    expect(result.decision).toBe('UNCERTAIN_RESPONSE');
  });

  // -------------------------------------------------------------------------
  // EG-9: CERTAIN + any impact → PROCEED
  // -------------------------------------------------------------------------
  it('EG-9: CERTAIN + any impact → PROCEED', () => {
    for (const impact of IMPACTS) {
      const result = gateToolCall({ tag: 'CERTAIN', impact });
      expect(result.decision).toBe('PROCEED');
    }
  });

  // -------------------------------------------------------------------------
  // EG-10: PROBABLE + any impact → PROCEED
  // -------------------------------------------------------------------------
  it('EG-10: PROBABLE + any impact → PROCEED', () => {
    for (const impact of IMPACTS) {
      const result = gateToolCall({ tag: 'PROBABLE', impact });
      expect(result.decision).toBe('PROCEED');
    }
  });

  // -------------------------------------------------------------------------
  // EG-11: Random rationale texts do not throw from classifyRationale
  // -------------------------------------------------------------------------
  it('EG-11: 100 random rationale texts classified without throwing', () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < 100; i++) {
      const text = randomText(rand, Math.floor(rand() * 20) + 1);
      expect(() => classifyRationale(text)).not.toThrow();
      const tag = classifyRationale(text);
      expect(TAGS).toContain(tag);
    }
  });

  // -------------------------------------------------------------------------
  // EG-12: Malformed/empty rationale → PROBABLE (model silence ≠ explicit uncertainty)
  // Previously returned UNKNOWN, causing infinite REPLAN loops on CRITICAL tools.
  // -------------------------------------------------------------------------
  it('EG-12: empty, null, and whitespace rationale → PROBABLE (not UNKNOWN)', () => {
    const malformed = ['', '   ', '\t\n', null as unknown as string, undefined as unknown as string];
    for (const m of malformed) {
      expect(() => classifyRationale(m)).not.toThrow();
      const tag = classifyRationale(m);
      expect(tag).toBe('PROBABLE');
    }
  });

  // -------------------------------------------------------------------------
  // EG-13: Conjecture keywords reliably classified
  // -------------------------------------------------------------------------
  it('EG-13: conjecture hedge keywords produce CONJECTURE tag', () => {
    const conjectureTexts = [
      'I think this will work',
      'I believe the answer is yes',
      'probably the best approach',
      'likely it will succeed',
      'perhaps we should try this',
      'maybe this is correct',
      'it might be the case',
      'could be related to the issue',
      'I guess that is fine',
      'I assume this is valid',
      'I suspect the problem is here',
    ];
    for (const text of conjectureTexts) {
      const tag = classifyRationale(text);
      expect(tag).toBe('CONJECTURE');
    }
  });

  // -------------------------------------------------------------------------
  // EG-14: Unknown keywords reliably classified
  // -------------------------------------------------------------------------
  it('EG-14: unknown hedge keywords produce UNKNOWN tag', () => {
    const unknownTexts = [
      "I don't know the answer",
      'I do not know this',
      'no information available',
      'cannot determine the outcome',
      'I have no data on this',
    ];
    for (const text of unknownTexts) {
      const tag = classifyRationale(text);
      expect(tag).toBe('UNKNOWN');
    }
  });

  // -------------------------------------------------------------------------
  // EG-15: Probable keywords classified as PROBABLE
  // -------------------------------------------------------------------------
  it('EG-15: probable keywords produce PROBABLE tag (when no unknown/conjecture precedes)', () => {
    const probableTexts = [
      'it appears to be correct',
      'it seems the value is right',
      'evidence suggests this approach',
      'based on the data provided',
      'typically this pattern works',
      'usually this is the case',
      'generally speaking, this is fine',
    ];
    for (const text of probableTexts) {
      const tag = classifyRationale(text);
      expect(tag).toBe('PROBABLE');
    }
  });

  // -------------------------------------------------------------------------
  // EG-16: Plain text with no hedge markers → CERTAIN
  // -------------------------------------------------------------------------
  it('EG-16: plain confident text without hedge markers → CERTAIN', () => {
    const certainTexts = [
      'The server is running on port 8080',
      'This function returns a boolean value',
      'The configuration file is located at /etc/app.conf',
      'Today is Monday and the market is open',
    ];
    for (const text of certainTexts) {
      const tag = classifyRationale(text);
      expect(tag).toBe('CERTAIN');
    }
  });

  // -------------------------------------------------------------------------
  // EG-17: classifyImpact — critical tool names
  // -------------------------------------------------------------------------
  it('EG-17: classifyImpact returns CRITICAL for delete/drop/exec tools', () => {
    const criticalTools = ['deleteFile', 'dropTable', 'rm_file', 'wipeDatabase', 'formatDisk',
      'shutdownServer', 'execCommand', 'evalCode', 'shellExec'];
    for (const tool of criticalTools) {
      expect(classifyImpact(tool)).toBe('CRITICAL');
    }
  });

  // -------------------------------------------------------------------------
  // EG-18: classifyImpact — high impact tools
  // -------------------------------------------------------------------------
  it('EG-18: classifyImpact returns HIGH for write/create/update tools', () => {
    const highTools = ['writeFile', 'createRecord', 'updateUser', 'insertRow', 'postMessage',
      'putObject', 'patchConfig'];
    for (const tool of highTools) {
      expect(classifyImpact(tool)).toBe('HIGH');
    }
  });

  // -------------------------------------------------------------------------
  // EG-19: classifyImpact — medium impact tools
  // -------------------------------------------------------------------------
  it('EG-19: classifyImpact returns MEDIUM for send/query/fetch tools', () => {
    const mediumTools = ['sendEmail', 'queryDatabase', 'fetchData', 'readFile', 'alertUser', 'notifyAdmin', 'messageUser'];
    for (const tool of mediumTools) {
      expect(classifyImpact(tool)).toBe('MEDIUM');
    }
  });

  // -------------------------------------------------------------------------
  // EG-20: All 16 (tag x impact) combos produce valid decisions
  // -------------------------------------------------------------------------
  it('EG-20: all 16 tag x impact combinations return valid GateDecision', () => {
    for (const tag of TAGS) {
      for (const impact of IMPACTS) {
        const result = gateToolCall({ tag, impact });
        expect(VALID_DECISIONS).toContain(result.decision);
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });

  // -------------------------------------------------------------------------
  // EG-21: buildConjectureCommitError truncates rationale to 200 chars
  // -------------------------------------------------------------------------
  it('EG-21: buildConjectureCommitError truncates rationale to 200 chars max', () => {
    const longRationale = 'x'.repeat(500);
    const err = buildConjectureCommitError('CONJECTURE', 'HIGH', longRationale, 'session-abc');
    expect(err.type).toBe('ConjectureCommitError');
    expect(err.rationale.length).toBe(200);
    expect(err.tag).toBe('CONJECTURE');
    expect(err.impact).toBe('HIGH');
    expect(err.sessionId).toBe('session-abc');
  });

  // -------------------------------------------------------------------------
  // EG-22: buildConjectureCommitError with short rationale preserved
  // -------------------------------------------------------------------------
  it('EG-22: buildConjectureCommitError preserves short rationale verbatim', () => {
    const shortRationale = 'I think this is right';
    const err = buildConjectureCommitError('CONJECTURE', 'MEDIUM', shortRationale);
    expect(err.rationale).toBe(shortRationale);
    expect(err.sessionId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // EG-23: EpistemicGate.evaluate without DB never throws
  // -------------------------------------------------------------------------
  it('EG-23: EpistemicGate.evaluate without DB never throws on any input', () => {
    const gate = new EpistemicGate(); // no DB
    const inputs = [
      { rationale: 'I think this will work', toolName: 'writeFile', sessionId: 'sess-1' },
      { rationale: 'I do not know', toolName: 'deleteAll', sessionId: undefined },
      { rationale: '', toolName: 'fetchData', sessionId: 'sess-2' },
      { rationale: null as unknown as string, toolName: 'execShell', sessionId: undefined },
      { rationale: 'The server is running', toolName: 'queryDb', sessionId: 'sess-3' },
    ];
    for (const input of inputs) {
      expect(() => gate.evaluate(input.rationale, input.toolName, input.sessionId)).not.toThrow();
      const result = gate.evaluate(input.rationale, input.toolName, input.sessionId);
      expect(TAGS).toContain(result.tag);
      expect(IMPACTS).toContain(result.impact);
      expect(VALID_DECISIONS).toContain(result.result.decision);
    }
  });

  // -------------------------------------------------------------------------
  // EG-24: Random mixed text — no throws
  // -------------------------------------------------------------------------
  it('EG-24: 50 random mixed texts evaluated without throwing', () => {
    const rand = mulberry32(SEED + 7);
    const gate = new EpistemicGate();
    for (let i = 0; i < 50; i++) {
      const rationale = randomText(rand, Math.floor(rand() * 15) + 1);
      const toolName = ['writeFile', 'deleteAll', 'fetchData', 'execShell', 'queryDb'][Math.floor(rand() * 5)]!;
      expect(() => gate.evaluate(rationale, toolName)).not.toThrow();
    }
  });

  // -------------------------------------------------------------------------
  // EG-25: First-match order — UNKNOWN wins over CONJECTURE in same text
  // -------------------------------------------------------------------------
  it('EG-25: first-match order — UNKNOWN before CONJECTURE in rationale → UNKNOWN', () => {
    // "I don't know" appears before "I think" — UNKNOWN should win
    const text = "I don't know but I think it might work";
    const tag = classifyRationale(text);
    expect(tag).toBe('UNKNOWN');
  });

  // -------------------------------------------------------------------------
  // EG-26: buildUncertaintyResponse has correct shape
  // -------------------------------------------------------------------------
  it('EG-26: buildUncertaintyResponse contains expected type and fields', () => {
    const response = buildUncertaintyResponse('UNKNOWN', 'fetchData');
    expect(response.type).toBe('UncertaintyResponse');
    expect(response.tag).toBe('UNKNOWN');
    expect(response.message).toMatch(/EpistemicGate/);
    expect(response.message).toMatch(/fetchData/);
    expect(response.message).toMatch(/UNKNOWN/);
  });

  // -------------------------------------------------------------------------
  // EG-27: listDecisions without DB returns empty array
  // -------------------------------------------------------------------------
  it('EG-27: listDecisions without DB returns empty array', () => {
    const gate = new EpistemicGate(); // no DB
    const result = gate.listDecisions({ limit: 10 });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // EG-28: getStats without DB returns zeroed stats
  // -------------------------------------------------------------------------
  it('EG-28: getStats without DB returns zeroed stats object', () => {
    const gate = new EpistemicGate(); // no DB
    const stats = gate.getStats({});
    expect(stats.total).toBe(0);
    expect(stats.blockRate).toBe(0);
    expect(stats.byDecision.BLOCK).toBe(0);
    expect(stats.byDecision.PASS).toBe(0);
    expect(stats.byDecision.UNCERTAIN).toBe(0);
    expect(typeof stats.window.sinceMs).toBe('number');
    expect(typeof stats.window.untilMs).toBe('number');
  });
});

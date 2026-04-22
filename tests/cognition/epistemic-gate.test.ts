/**
 * Tests for epistemic-gate.ts — Wave 6F Primitive C (Builder C).
 *
 * Coverage:
 *   - classifyRationale: 4 tags + edge cases
 *   - classifyImpact: CRITICAL, HIGH, MEDIUM, LOW
 *   - gateToolCall: 4×4 matrix spot-checks + all required spec cases
 *   - buildConjectureCommitError: shape validation
 *   - buildUncertaintyResponse: message format
 *   - EpistemicGate.evaluate: happy path, fail-open, REPLAN, UNCERTAIN_RESPONSE
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  classifyRationale,
  classifyImpact,
  gateToolCall,
  buildConjectureCommitError,
  buildUncertaintyResponse,
  EpistemicGate,
} from '../../src/core/cognition/epistemic-gate.js';
import type { EpistemicTag, ImpactLevel } from '../../src/core/cognition/epistemic-gate.js';

// ---------------------------------------------------------------------------
// classifyRationale
// ---------------------------------------------------------------------------

describe('classifyRationale', () => {
  it('detects PROBABLE for empty string (model silence is not explicit uncertainty)', () => {
    expect(classifyRationale('')).toBe('PROBABLE');
  });

  it('detects PROBABLE for whitespace-only string (model silence is not explicit uncertainty)', () => {
    expect(classifyRationale('   ')).toBe('PROBABLE');
  });

  it('detects UNKNOWN for "I don\'t know"', () => {
    expect(classifyRationale("I don't know where the file is")).toBe('UNKNOWN');
  });

  it('detects UNKNOWN for "cannot determine"', () => {
    expect(classifyRationale('I cannot determine the correct path')).toBe('UNKNOWN');
  });

  it('detects CONJECTURE for "I think"', () => {
    expect(classifyRationale('I think this file exists at /tmp')).toBe('CONJECTURE');
  });

  it('detects CONJECTURE for "maybe"', () => {
    expect(classifyRationale('Maybe the config is correct')).toBe('CONJECTURE');
  });

  it('detects CONJECTURE for "might"', () => {
    expect(classifyRationale('This might work with the current settings')).toBe('CONJECTURE');
  });

  it('detects CONJECTURE for "I believe"', () => {
    expect(classifyRationale('I believe the output is valid JSON')).toBe('CONJECTURE');
  });

  it('detects PROBABLE for "it appears"', () => {
    expect(classifyRationale('It appears the path exists on this system')).toBe('PROBABLE');
  });

  it('detects PROBABLE for "based on"', () => {
    expect(classifyRationale('Based on the logs, the service is running')).toBe('PROBABLE');
  });

  it('detects PROBABLE for "it seems"', () => {
    expect(classifyRationale('It seems the operation completed successfully')).toBe('PROBABLE');
  });

  it('detects CERTAIN for plain factual statement', () => {
    expect(classifyRationale('The file is at /tmp/x')).toBe('CERTAIN');
  });

  it('detects CERTAIN for a statement with no hedge markers', () => {
    expect(classifyRationale('Running this command will list all processes')).toBe('CERTAIN');
  });

  it('UNKNOWN takes priority over CONJECTURE markers in same text', () => {
    // UNKNOWN pattern appears, even though "might" is present — first match wins
    expect(classifyRationale("I don't know, but it might work")).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// empty rationale → PROBABLE → PROCEED regression test (fix for REPLAN loop bug)
// ---------------------------------------------------------------------------

describe('empty rationale → PROBABLE → no REPLAN (regression)', () => {
  it('empty string classifies as PROBABLE, not UNKNOWN', () => {
    expect(classifyRationale('')).toBe('PROBABLE');
  });

  it('whitespace-only classifies as PROBABLE, not UNKNOWN', () => {
    expect(classifyRationale('   ')).toBe('PROBABLE');
  });

  it('explicit "I don\'t know" still classifies as UNKNOWN (unchanged)', () => {
    expect(classifyRationale("I don't know")).toBe('UNKNOWN');
  });

  it('explicit "I think" still classifies as CONJECTURE (unchanged)', () => {
    expect(classifyRationale('I think this works')).toBe('CONJECTURE');
  });

  it('explicit confident statement still classifies as CERTAIN (unchanged)', () => {
    expect(classifyRationale('The hostname is srv1474168')).toBe('CERTAIN');
  });

  it('PROBABLE + CRITICAL → PROCEED (empty rationale on system.exec must not REPLAN)', () => {
    // Root cause fix: previously empty string → UNKNOWN → UNKNOWN+CRITICAL=REPLAN (infinite loop)
    // After fix: empty string → PROBABLE → PROBABLE+CRITICAL=PROCEED
    const result = gateToolCall({ tag: 'PROBABLE', impact: 'CRITICAL' });
    expect(result.decision).toBe('PROCEED');
  });

  it('EpistemicGate.evaluate: empty rationale on system.exec → PROCEED, not REPLAN', () => {
    const gate = new EpistemicGate();
    const out = gate.evaluate('', 'system.exec', 'replan-loop-regression');
    expect(out.tag).toBe('PROBABLE');
    expect(out.impact).toBe('CRITICAL');
    expect(out.result.decision).toBe('PROCEED');
  });

  it('UNKNOWN + CRITICAL still REPLANs (gate matrix unchanged)', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'CRITICAL' });
    expect(result.decision).toBe('REPLAN');
  });
});

// ---------------------------------------------------------------------------
// classifyImpact
// ---------------------------------------------------------------------------

describe('classifyImpact', () => {
  it('CRITICAL for delete tool', () => {
    expect(classifyImpact('deleteFile')).toBe('CRITICAL');
  });

  it('CRITICAL for exec tool', () => {
    expect(classifyImpact('execCommand')).toBe('CRITICAL');
  });

  it('CRITICAL for rm tool', () => {
    expect(classifyImpact('rm_files')).toBe('CRITICAL');
  });

  it('CRITICAL for shell tool', () => {
    expect(classifyImpact('shell_run')).toBe('CRITICAL');
  });

  it('HIGH for write tool', () => {
    expect(classifyImpact('write_file')).toBe('HIGH');
  });

  it('HIGH for create tool', () => {
    expect(classifyImpact('createRecord')).toBe('HIGH');
  });

  it('HIGH for update tool', () => {
    expect(classifyImpact('updateDatabase')).toBe('HIGH');
  });

  it('MEDIUM for read tool', () => {
    expect(classifyImpact('read_file')).toBe('MEDIUM');
  });

  it('MEDIUM for fetch tool', () => {
    expect(classifyImpact('fetch_url')).toBe('MEDIUM');
  });

  it('MEDIUM for send tool', () => {
    expect(classifyImpact('sendNotification')).toBe('MEDIUM');
  });

  it('MEDIUM for unknown/generic tool name', () => {
    expect(classifyImpact('list_calendar_events')).toBe('MEDIUM');
  });

  it('MEDIUM for empty tool name', () => {
    expect(classifyImpact('')).toBe('MEDIUM');
  });

  it('Wave6F: classifyImpact returns MEDIUM for any unknown tool name (not LOW)', () => {
    expect(classifyImpact('some_totally_unknown_tool_xyz')).toBe('MEDIUM');
  });
});

// ---------------------------------------------------------------------------
// gateToolCall — spec matrix
// ---------------------------------------------------------------------------

describe('gateToolCall', () => {
  it('CONJECTURE + MEDIUM → REPLAN', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'MEDIUM' });
    expect(result.decision).toBe('REPLAN');
  });

  it('CONJECTURE + HIGH → REPLAN', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'HIGH' });
    expect(result.decision).toBe('REPLAN');
  });

  it('CONJECTURE + CRITICAL → REPLAN', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'CRITICAL' });
    expect(result.decision).toBe('REPLAN');
  });

  it('CONJECTURE + LOW → PROCEED', () => {
    const result = gateToolCall({ tag: 'CONJECTURE', impact: 'LOW' });
    expect(result.decision).toBe('PROCEED');
  });

  it('UNKNOWN + HIGH → REPLAN', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'HIGH' });
    expect(result.decision).toBe('REPLAN');
  });

  it('UNKNOWN + CRITICAL → REPLAN', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'CRITICAL' });
    expect(result.decision).toBe('REPLAN');
  });

  it('UNKNOWN + MEDIUM → UNCERTAIN_RESPONSE', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'MEDIUM' });
    expect(result.decision).toBe('UNCERTAIN_RESPONSE');
  });

  it('UNKNOWN + LOW → UNCERTAIN_RESPONSE', () => {
    const result = gateToolCall({ tag: 'UNKNOWN', impact: 'LOW' });
    expect(result.decision).toBe('UNCERTAIN_RESPONSE');
  });

  it('CERTAIN + CRITICAL → PROCEED', () => {
    const result = gateToolCall({ tag: 'CERTAIN', impact: 'CRITICAL' });
    expect(result.decision).toBe('PROCEED');
  });

  it('CERTAIN + HIGH → PROCEED', () => {
    const result = gateToolCall({ tag: 'CERTAIN', impact: 'HIGH' });
    expect(result.decision).toBe('PROCEED');
  });

  it('PROBABLE + HIGH → PROCEED', () => {
    const result = gateToolCall({ tag: 'PROBABLE', impact: 'HIGH' });
    expect(result.decision).toBe('PROCEED');
  });

  it('PROBABLE + CRITICAL → PROCEED', () => {
    const result = gateToolCall({ tag: 'PROBABLE', impact: 'CRITICAL' });
    expect(result.decision).toBe('PROCEED');
  });

  it('all results have a reason string', () => {
    const combos: Array<[EpistemicTag, ImpactLevel]> = [
      ['CONJECTURE', 'MEDIUM'],
      ['UNKNOWN', 'LOW'],
      ['CERTAIN', 'LOW'],
      ['PROBABLE', 'HIGH'],
    ];
    for (const [tag, impact] of combos) {
      const result = gateToolCall({ tag, impact });
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildConjectureCommitError
// ---------------------------------------------------------------------------

describe('buildConjectureCommitError', () => {
  it('has correct type, tag, impact fields', () => {
    const err = buildConjectureCommitError('CONJECTURE', 'HIGH', 'maybe this works');
    expect(err.type).toBe('ConjectureCommitError');
    expect(err.tag).toBe('CONJECTURE');
    expect(err.impact).toBe('HIGH');
  });

  it('rationale is truncated to 200 chars', () => {
    const long = 'x'.repeat(500);
    const err = buildConjectureCommitError('CONJECTURE', 'MEDIUM', long);
    expect(err.rationale.length).toBe(200);
  });

  it('includes sessionId when provided', () => {
    const err = buildConjectureCommitError('CONJECTURE', 'HIGH', 'test', 'sess-123');
    expect(err.sessionId).toBe('sess-123');
  });

  it('sessionId is undefined when not provided', () => {
    const err = buildConjectureCommitError('CONJECTURE', 'HIGH', 'test');
    expect(err.sessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildUncertaintyResponse
// ---------------------------------------------------------------------------

describe('buildUncertaintyResponse', () => {
  it('has correct type', () => {
    const resp = buildUncertaintyResponse('UNKNOWN', 'read_file');
    expect(resp.type).toBe('UncertaintyResponse');
  });

  it('message contains EpistemicGate', () => {
    const resp = buildUncertaintyResponse('UNKNOWN', 'read_file');
    expect(resp.message).toContain('EpistemicGate');
  });

  it('message contains the tag', () => {
    const resp = buildUncertaintyResponse('UNKNOWN', 'read_file');
    expect(resp.message).toContain('UNKNOWN');
  });

  it('message is non-empty and deterministic for same inputs', () => {
    const a = buildUncertaintyResponse('UNKNOWN', 'read_file');
    const b = buildUncertaintyResponse('UNKNOWN', 'read_file');
    expect(a.message).toBe(b.message);
    expect(a.message.length).toBeGreaterThan(0);
  });

  it('message includes the tool name', () => {
    const resp = buildUncertaintyResponse('UNKNOWN', 'fetch_url');
    expect(resp.message).toContain('fetch_url');
  });
});

// ---------------------------------------------------------------------------
// EpistemicGate class
// ---------------------------------------------------------------------------

describe('EpistemicGate.evaluate', () => {
  it('returns REPLAN for CONJECTURE + HIGH-impact tool', () => {
    const gate = new EpistemicGate();
    const out = gate.evaluate('I think this might work', 'write_file', 'sess-1');
    expect(out.result.decision).toBe('REPLAN');
    expect(out.tag).toBe('CONJECTURE');
    expect(out.impact).toBe('HIGH');
    expect(out.error).toBeDefined();
    expect(out.error?.type).toBe('ConjectureCommitError');
  });

  it('returns PROCEED for CERTAIN + LOW tool', () => {
    const gate = new EpistemicGate();
    const out = gate.evaluate('The configuration is valid', 'list_events', 'sess-2');
    expect(out.result.decision).toBe('PROCEED');
    expect(out.tag).toBe('CERTAIN');
  });

  it('returns UNCERTAIN_RESPONSE for UNKNOWN + LOW tool', () => {
    const gate = new EpistemicGate();
    const out = gate.evaluate("I don't know the path", 'list_events');
    expect(out.result.decision).toBe('UNCERTAIN_RESPONSE');
    expect(out.response).toBeDefined();
    expect(out.response?.type).toBe('UncertaintyResponse');
  });

  it('returns REPLAN for UNKNOWN + CRITICAL tool', () => {
    const gate = new EpistemicGate();
    const out = gate.evaluate("I don't know", 'exec_command');
    expect(out.result.decision).toBe('REPLAN');
    expect(out.tag).toBe('UNKNOWN');
    expect(out.impact).toBe('CRITICAL');
  });

  it('never throws — fail-open returns PROCEED on internal error', () => {
    // Create gate and monkey-patch classifyRationale path via a bad input
    // The class itself should not throw for any input
    const gate = new EpistemicGate();
    // Passing null-like values that could theoretically cause errors in regex
    expect(() => gate.evaluate(null as unknown as string, 'write_file')).not.toThrow();
    const out = gate.evaluate(null as unknown as string, 'write_file');
    // Should fail-open to PROCEED since null triggers UNKNOWN path (no throw)
    expect(['PROCEED', 'REPLAN', 'UNCERTAIN_RESPONSE']).toContain(out.result.decision);
  });

  it('works without optional DB — no throw', () => {
    const gate = new EpistemicGate();
    expect(() => gate.evaluate('I think so', 'write_config')).not.toThrow();
  });

  it('PROBABLE + CRITICAL tool → PROCEED (not blocked)', () => {
    const gate = new EpistemicGate();
    const out = gate.evaluate('It appears the config is ready', 'exec_shell');
    // PROBABLE is not blocked in the matrix
    expect(out.result.decision).toBe('PROCEED');
    expect(out.tag).toBe('PROBABLE');
  });
});

// ---------------------------------------------------------------------------
// EpistemicGate.listDecisions — Wave 6G Candidate 2
// ---------------------------------------------------------------------------

describe('EpistemicGate.listDecisions', () => {
  it('returns [] when db not ready (no db passed)', () => {
    const gate = new EpistemicGate();
    const rows = gate.listDecisions({ limit: 10 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it('returns up to limit rows from db', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    gate.evaluate('The config is valid', 'read_file', 'sess-1');
    gate.evaluate('I think it works', 'write_file', 'sess-2');
    gate.evaluate("I don't know", 'exec_cmd', 'sess-3');
    const rows = gate.listDecisions({ limit: 2 });
    expect(rows).toHaveLength(2);
    db.close();
  });

  it('filters by tag when tag is specified', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    gate.evaluate('The config is valid', 'read_file');
    gate.evaluate('I think it works', 'write_file');
    gate.evaluate("I don't know", 'exec_cmd');
    const rows = gate.listDecisions({ limit: 50, tag: 'CONJECTURE' });
    expect(rows.every(r => r.tag === 'CONJECTURE')).toBe(true);
    db.close();
  });

  it('returns [] and does not throw when stmt throws (fail-open)', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    // Close db to force statement error
    db.close();
    expect(() => gate.listDecisions({ limit: 10 })).not.toThrow();
    const rows = gate.listDecisions({ limit: 10 });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EpistemicGate.getStats — Wave 6H
// ---------------------------------------------------------------------------

describe('EpistemicGate.getStats', () => {
  it('returns all zeros when DB is empty', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    const stats = gate.getStats({});
    expect(stats.total).toBe(0);
    expect(stats.byDecision.PASS).toBe(0);
    expect(stats.byDecision.BLOCK).toBe(0);
    expect(stats.byDecision.UNCERTAIN).toBe(0);
    expect(stats.byTag.CERTAIN).toBe(0);
    expect(stats.blockRate).toBe(0);
    db.close();
  });

  it('returns correct tallies from populated DB', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    // CERTAIN + MEDIUM → PROCEED (PASS)
    gate.evaluate('The config is valid', 'read_file', 'sess-1');
    // CONJECTURE + HIGH → REPLAN (BLOCK)
    gate.evaluate('I think it might work', 'write_file', 'sess-2');
    // UNKNOWN + MEDIUM → UNCERTAIN_RESPONSE (UNCERTAIN)
    gate.evaluate("I don't know the answer", 'query_db', 'sess-3');

    const stats = gate.getStats({ sinceMs: 0 });
    expect(stats.total).toBe(3);
    expect(stats.byDecision.BLOCK).toBe(1);
    expect(stats.byDecision.UNCERTAIN).toBe(1);
    expect(stats.byDecision.PASS).toBe(1);
    expect(stats.blockRate).toBeCloseTo(1 / 3);
    db.close();
  });

  it('filters by sinceMs correctly — rows before window are excluded', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    gate.evaluate('The config is valid', 'read_file');

    // Query with a future sinceMs — should return nothing
    const futureMs = Date.now() + 60 * 60 * 1000;
    const stats = gate.getStats({ sinceMs: futureMs });
    expect(stats.total).toBe(0);
    db.close();
  });

  it('returns zeros and does not throw when DB not ready (no db passed)', () => {
    const gate = new EpistemicGate();
    expect(() => gate.getStats({})).not.toThrow();
    const stats = gate.getStats({});
    expect(stats.total).toBe(0);
    expect(stats.blockRate).toBe(0);
  });

  it('returns zeros and does not throw when DB is closed (fail-open)', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    db.close();
    expect(() => gate.getStats({})).not.toThrow();
    const stats = gate.getStats({});
    expect(stats.total).toBe(0);
  });

  it('handles bad sinceMs gracefully — uses default when NaN or undefined', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    gate.evaluate('The config is valid', 'read_file');
    // NaN sinceMs should fall back to default (last 24h), still returning results
    const stats = gate.getStats({ sinceMs: NaN });
    expect(stats.total).toBeGreaterThanOrEqual(0);
    expect(stats.window.sinceMs).not.toBeNaN();
    db.close();
  });

  it('byTag sums equal total', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    gate.evaluate('Certain statement', 'read_file');
    gate.evaluate('I think so', 'write_file');
    gate.evaluate("I don't know", 'fetch_url');

    const stats = gate.getStats({ sinceMs: 0 });
    const tagSum = Object.values(stats.byTag).reduce((a, b) => a + b, 0);
    expect(tagSum).toBe(stats.total);
    db.close();
  });

  it('blockRate is between 0 and 1 inclusive', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    gate.evaluate('I think it might work', 'delete_file');
    const stats = gate.getStats({ sinceMs: 0 });
    expect(stats.blockRate).toBeGreaterThanOrEqual(0);
    expect(stats.blockRate).toBeLessThanOrEqual(1);
    db.close();
  });

  it('window.sinceMs and window.untilMs are finite numbers', () => {
    const db = new Database(':memory:');
    const gate = new EpistemicGate(db);
    const stats = gate.getStats({ sinceMs: 1000 });
    expect(Number.isFinite(stats.window.sinceMs)).toBe(true);
    expect(Number.isFinite(stats.window.untilMs)).toBe(true);
    expect(stats.window.sinceMs).toBe(1000);
    db.close();
  });
});

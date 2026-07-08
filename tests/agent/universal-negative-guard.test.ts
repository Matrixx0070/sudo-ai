/**
 * Tests for the final-answer universal-negative guard.
 *
 * Detector precision is the core contract: unqualified universal negatives in
 * research answers ARE flagged; hedged/search-scoped negatives and legitimate
 * local negatives (files, rows, functions) are NOT.
 */
import { describe, it, expect } from 'vitest';
import {
  detectUniversalNegatives,
  isResearchToolName,
  usedResearchTools,
  isUniversalNegativeGuardEnabled,
  runUniversalNegativeGuard,
  buildRevisionPrompt,
  SCOPE_CAVEAT,
} from '../../src/core/agent/universal-negative-guard.js';

describe('detectUniversalNegatives — flags unqualified universal negatives', () => {
  it('flags "there are no name collisions"', () => {
    const flagged = detectUniversalNegatives('I checked thoroughly. There are no name collisions.');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain('no name collisions');
  });

  it('flags the live-observed OpenClaw overclaim', () => {
    const answer =
      'There are **no name collisions**. "OpenClaw" is clear: no other entity (past or present) uses it.';
    const flagged = detectUniversalNegatives(answer);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
  });

  it('flags "no other OpenClaw exists"', () => {
    expect(detectUniversalNegatives('No other OpenClaw exists anywhere on the web.')).toHaveLength(1);
  });

  it('flags "the company does not exist"', () => {
    expect(detectUniversalNegatives('That company does not exist.')).toHaveLength(1);
  });

  it('flags "did not exist before" / "never existed"', () => {
    expect(detectUniversalNegatives('This product did not exist before 2020.')).toHaveLength(1);
    expect(detectUniversalNegatives('Such an organization never existed.')).toHaveLength(1);
  });

  it('flags "there is no such product"', () => {
    expect(detectUniversalNegatives('There is no such product on the market.')).toHaveLength(1);
  });

  it('flags "nothing else matches"', () => {
    expect(detectUniversalNegatives('Nothing else matches that name.')).toHaveLength(1);
  });

  it('flags "nobody else uses that name"', () => {
    expect(detectUniversalNegatives('Nobody else uses that name.')).toHaveLength(1);
  });

  it('flags "is the only one of its kind"', () => {
    expect(detectUniversalNegatives('This engine is the only one of its kind.')).toHaveLength(1);
  });
});

describe('detectUniversalNegatives — does NOT flag properly scoped claims', () => {
  it('passes "I didn\'t find any other OpenClaw in my searches"', () => {
    expect(
      detectUniversalNegatives("I didn't find any other OpenClaw in my searches, so I can't fully rule out a collision."),
    ).toHaveLength(0);
  });

  it('passes "my searches did not turn up any other project"', () => {
    expect(detectUniversalNegatives('My searches did not turn up any other project with this name.')).toHaveLength(0);
  });

  it('passes "found no evidence … cannot be fully ruled out"', () => {
    expect(
      detectUniversalNegatives('I found no other entity using the name; a collision cannot be fully ruled out.'),
    ).toHaveLength(0);
  });

  it('passes "as far as I can tell, no other project uses it"', () => {
    expect(detectUniversalNegatives('As far as I can tell, no other project uses it.')).toHaveLength(0);
  });

  it('passes "based on these results, there is no such listing"', () => {
    expect(detectUniversalNegatives('Based on these results, there is no such listing.')).toHaveLength(0);
  });
});

describe('detectUniversalNegatives — does NOT flag legitimate local negatives (precision guard)', () => {
  it('passes "there is no file at /tmp/x"', () => {
    expect(detectUniversalNegatives('There is no such file at /tmp/x.')).toHaveLength(0);
    expect(detectUniversalNegatives('No file exists at that path.')).toHaveLength(0);
  });

  it('passes "0 rows returned" / "no rows matched"', () => {
    expect(detectUniversalNegatives('The query returned 0 rows; no rows matched.')).toHaveLength(0);
  });

  it('passes "that function does not exist in this file"', () => {
    expect(detectUniversalNegatives('That function does not exist in this file.')).toHaveLength(0);
  });

  it('passes "no other module imports it in the codebase"', () => {
    expect(detectUniversalNegatives('No other module imports it anywhere in the codebase.')).toHaveLength(0);
  });

  it('passes "the table does not exist in the database"', () => {
    expect(detectUniversalNegatives('The api_costs table does not exist in the database.')).toHaveLength(0);
  });

  it('passes "no merge conflicts" (bare conflicts deliberately unmatched)', () => {
    expect(detectUniversalNegatives('The rebase finished with no conflicts.')).toHaveLength(0);
  });

  it('ignores universal negatives inside code blocks', () => {
    const text = 'Here is the log:\n```\nERROR: no other instance exists\n```\nAll good.';
    expect(detectUniversalNegatives(text)).toHaveLength(0);
  });

  it('returns [] on empty / non-string-ish input', () => {
    expect(detectUniversalNegatives('')).toHaveLength(0);
    expect(detectUniversalNegatives(undefined as unknown as string)).toHaveLength(0);
  });
});

describe('research-turn scoping', () => {
  it('classifies browser.* and web-search tools as research tools', () => {
    expect(isResearchToolName('browser.search')).toBe(true);
    expect(isResearchToolName('browser.fetch')).toBe(true);
    expect(isResearchToolName('browser.navigate')).toBe(true);
    expect(isResearchToolName('web_search')).toBe(true);
    expect(isResearchToolName('search_web')).toBe(true);
    expect(isResearchToolName('fetch_url')).toBe(true);
  });

  it('does NOT classify local tools as research tools', () => {
    expect(isResearchToolName('file.read')).toBe(false);
    expect(isResearchToolName('memory.search')).toBe(false);
    expect(isResearchToolName('rag.search')).toBe(false);
    expect(isResearchToolName('exec.command')).toBe(false);
    expect(isResearchToolName('comms.webhook')).toBe(false);
  });

  it('usedResearchTools requires at least one research tool', () => {
    expect(usedResearchTools(['file.read', 'exec.command'])).toBe(false);
    expect(usedResearchTools(['file.read', 'browser.search'])).toBe(true);
    expect(usedResearchTools([])).toBe(false);
  });
});

describe('kill-switch', () => {
  it('defaults ON; =0 disables; =1 enables', () => {
    expect(isUniversalNegativeGuardEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isUniversalNegativeGuardEnabled({ SUDO_UNIVERSAL_NEGATIVE_GUARD: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isUniversalNegativeGuardEnabled({ SUDO_UNIVERSAL_NEGATIVE_GUARD: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

const OVERCLAIM = 'There are no name collisions. No other entity uses the name OpenClaw.';
const CLEAN_REVISION =
  "I didn't find any other entity using the name OpenClaw in my searches, so I can't fully rule out a collision.";

describe('runUniversalNegativeGuard — action path', () => {
  it('flagged answer on a research turn → exactly one corrective pass, revision adopted', async () => {
    let calls = 0;
    const result = await runUniversalNegativeGuard({
      answer: OVERCLAIM,
      toolNamesUsed: ['browser.search', 'browser.fetch'],
      originalRequest: 'Rule out name collisions for OpenClaw',
      revise: async (prompt) => {
        calls++;
        expect(prompt).toContain('OFFENDING SENTENCES');
        expect(prompt).toContain('no name collisions');
        return CLEAN_REVISION;
      },
    });
    expect(calls).toBe(1);
    expect(result.action).toBe('revised');
    expect(result.answer).toBe(CLEAN_REVISION);
    expect(result.flagged.length).toBeGreaterThanOrEqual(1);
  });

  it('revision still overclaiming → caveat appended, no second pass', async () => {
    let calls = 0;
    const result = await runUniversalNegativeGuard({
      answer: OVERCLAIM,
      toolNamesUsed: ['browser.search'],
      originalRequest: 'q',
      revise: async () => {
        calls++;
        return 'Definitely: there are no name collisions.';
      },
    });
    expect(calls).toBe(1);
    expect(result.action).toBe('caveat-appended');
    expect(result.answer).toBe(OVERCLAIM + SCOPE_CAVEAT);
  });

  it('revise throws → fail-open with caveat appended (never breaks the turn)', async () => {
    const result = await runUniversalNegativeGuard({
      answer: OVERCLAIM,
      toolNamesUsed: ['browser.search'],
      originalRequest: 'q',
      revise: async () => {
        throw new Error('brain down');
      },
    });
    expect(result.action).toBe('caveat-appended');
    expect(result.answer.startsWith(OVERCLAIM)).toBe(true);
  });

  it('detector-level guard error → original answer returned untouched (fail-open)', async () => {
    // Force an internal throw by making toolNamesUsed.some blow up.
    const evil = { some: () => { throw new Error('boom'); } } as unknown as string[];
    const result = await runUniversalNegativeGuard({
      answer: OVERCLAIM,
      toolNamesUsed: evil,
      originalRequest: 'q',
      revise: async () => CLEAN_REVISION,
    });
    expect(result.action).toBe('error');
    expect(result.answer).toBe(OVERCLAIM);
  });

  it('kill-switch off → no-op even on a flagged research answer', async () => {
    let calls = 0;
    const result = await runUniversalNegativeGuard({
      answer: OVERCLAIM,
      toolNamesUsed: ['browser.search'],
      originalRequest: 'q',
      revise: async () => { calls++; return CLEAN_REVISION; },
      env: { SUDO_UNIVERSAL_NEGATIVE_GUARD: '0' } as NodeJS.ProcessEnv,
    });
    expect(calls).toBe(0);
    expect(result.action).toBe('off');
    expect(result.answer).toBe(OVERCLAIM);
  });

  it('non-research turn → no-op even when the text would flag', async () => {
    let calls = 0;
    const result = await runUniversalNegativeGuard({
      answer: OVERCLAIM,
      toolNamesUsed: ['file.read', 'exec.command'],
      originalRequest: 'q',
      revise: async () => { calls++; return CLEAN_REVISION; },
    });
    expect(calls).toBe(0);
    expect(result.action).toBe('not-research-turn');
    expect(result.answer).toBe(OVERCLAIM);
  });

  it('clean research answer → no corrective pass', async () => {
    let calls = 0;
    const result = await runUniversalNegativeGuard({
      answer: CLEAN_REVISION,
      toolNamesUsed: ['browser.search'],
      originalRequest: 'q',
      revise: async () => { calls++; return 'x'; },
    });
    expect(calls).toBe(0);
    expect(result.action).toBe('clean');
  });

  it('empty revision → caveat appended', async () => {
    const result = await runUniversalNegativeGuard({
      answer: OVERCLAIM,
      toolNamesUsed: ['browser.search'],
      originalRequest: 'q',
      revise: async () => '   ',
    });
    expect(result.action).toBe('caveat-appended');
  });
});

describe('buildRevisionPrompt', () => {
  it('includes the offending sentences, the request, and the reply', () => {
    const p = buildRevisionPrompt('ANSWER BODY', ['There are no name collisions.'], 'the request');
    expect(p).toContain('There are no name collisions.');
    expect(p).toContain('the request');
    expect(p).toContain('ANSWER BODY');
  });
});

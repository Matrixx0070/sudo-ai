/**
 * loop-helpers-unit.test.ts — F124 behavior pins for exported pure helpers in
 * src/core/agent/loop-helpers.ts.
 *
 * Focus: classifyShipEditSignals (previously ZERO coverage) plus tight pins on
 * neighboring pure helpers exercised here from the unit angle (existing suites
 * cover them only through higher-level flows).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyShipEditSignals,
  extractTurnMutations,
  collapseContent,
  selectVerbatimTail,
  selectPinnedGoal,
  sanitizeToolPairing,
  dropPriorAlignmentAdvisories,
  trimSessionMessages,
  resolveSemanticPlanCap,
  semanticPlanAllowed,
  PINNED_GOAL_PREFIX,
  TRUNCATED_TOOL_RESULT_PLACEHOLDER,
  SESSION_MESSAGE_TRIM_THRESHOLD,
  SESSION_MESSAGE_KEEP_COUNT,
  type BrainMessage,
} from '../../src/core/agent/loop-helpers.js';

// ---------------------------------------------------------------------------
// classifyShipEditSignals — completion-guard trigger B (uncovered until now)
// ---------------------------------------------------------------------------

type TurnMsg = { role: string; toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }> };

const assistantCall = (name: string, args: Record<string, unknown> = {}): TurnMsg => ({
  role: 'assistant',
  toolCalls: [{ name, arguments: args }],
});

describe('classifyShipEditSignals', () => {
  it('returns both-false for an empty turn', () => {
    expect(classifyShipEditSignals([])).toEqual({ editedSrcOrTest: false, deployed: false });
  });

  it('flags editedSrcOrTest for a prefixed coder edit under src/', () => {
    const res = classifyShipEditSignals([
      assistantCall('coder.write-file', { path: 'src/core/x.ts', content: '' }),
    ]);
    expect(res).toEqual({ editedSrcOrTest: true, deployed: false });
  });

  it('matches BARE tool names too (live histories emit "write-file" without prefix)', () => {
    const res = classifyShipEditSignals([
      assistantCall('write-file', { path: 'tests/agent/y.test.ts' }),
    ]);
    expect(res.editedSrcOrTest).toBe(true);
  });

  it('does NOT trip on workspace/memory scratch edits outside src/ or tests/', () => {
    const res = classifyShipEditSignals([
      assistantCall('coder.write-file', { path: 'workspace/MEMORY.md' }),
      assistantCall('edit-file', { path: 'docs/notes.md' }),
    ]);
    expect(res.editedSrcOrTest).toBe(false);
  });

  it('requires a path SEGMENT: "mysrc/x.ts" does not count, "a/src/x.ts" does', () => {
    expect(classifyShipEditSignals([assistantCall('edit-file', { path: 'mysrc/x.ts' })]).editedSrcOrTest).toBe(false);
    expect(classifyShipEditSignals([assistantCall('edit-file', { path: 'repo/src/x.ts' })]).editedSrcOrTest).toBe(true);
  });

  it('accepts filePath and file as path aliases', () => {
    expect(classifyShipEditSignals([assistantCall('smart-edit', { filePath: 'src/a.ts' })]).editedSrcOrTest).toBe(true);
    expect(classifyShipEditSignals([assistantCall('apply-patch', { file: 'tests/b.ts' })]).editedSrcOrTest).toBe(true);
  });

  it('meta.self-modify write-file/edit-file actions count as code edits', () => {
    const res = classifyShipEditSignals([
      assistantCall('meta.self-modify', { action: 'edit-file', path: 'src/core/z.ts' }),
    ]);
    expect(res).toEqual({ editedSrcOrTest: true, deployed: false });
  });

  it('meta.self-modify restart / full-cycle set deployed (bare name variant too)', () => {
    expect(classifyShipEditSignals([assistantCall('meta.self-modify', { action: 'restart' })]).deployed).toBe(true);
    expect(classifyShipEditSignals([assistantCall('self-modify', { action: 'full-cycle' })]).deployed).toBe(true);
  });

  it('self-modify build/test actions are NOT deploy signals', () => {
    const res = classifyShipEditSignals([
      assistantCall('meta.self-modify', { action: 'build' }),
      assistantCall('meta.self-modify', { action: 'test' }),
    ]);
    expect(res.deployed).toBe(false);
  });

  it('ignores non-assistant messages and assistant messages without toolCalls', () => {
    const res = classifyShipEditSignals([
      { role: 'user' },
      { role: 'tool' },
      { role: 'assistant' },
    ]);
    expect(res).toEqual({ editedSrcOrTest: false, deployed: false });
  });
});

// ---------------------------------------------------------------------------
// extractTurnMutations
// ---------------------------------------------------------------------------

describe('extractTurnMutations', () => {
  it('digests file-mutating calls into "path (tool action)" labels', () => {
    const out = extractTurnMutations([
      assistantCall('coder.write-file', { path: 'src/a.ts' }),
      assistantCall('meta.self-modify', { action: 'edit-file', path: 'src/b.ts' }),
    ]);
    expect(out).toEqual(['src/a.ts (coder.write-file)', 'src/b.ts (meta.self-modify edit-file)']);
  });

  it('dedupes repeated (tool, path) pairs and skips non-mutating tools', () => {
    const out = extractTurnMutations([
      assistantCall('coder.write-file', { path: 'src/a.ts' }),
      assistantCall('coder.write-file', { path: 'src/a.ts' }),
      assistantCall('coder.read-file', { path: 'src/a.ts' }),
      assistantCall('shell-exec', { command: 'rm -rf /' }),
    ]);
    expect(out).toEqual(['src/a.ts (coder.write-file)']);
  });

  it('falls back to action, then tool name, when no path argument exists', () => {
    const out = extractTurnMutations([
      assistantCall('meta.self-modify', { action: 'full-cycle' }),
      assistantCall('coder.apply-patch', {}),
    ]);
    expect(out).toEqual([
      'full-cycle (meta.self-modify full-cycle)',
      'coder.apply-patch (coder.apply-patch)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// collapseContent
// ---------------------------------------------------------------------------

describe('collapseContent', () => {
  it('passes short content through untouched', () => {
    expect(collapseContent('short', 'anything')).toBe('short');
  });

  it('summarizes tsc output: count header + first 10 error lines + remainder marker', () => {
    const errors = Array.from({ length: 12 }, (_, i) => `src/x.ts(${i},1): error TS2304: Cannot find name`);
    const content = (errors.join('\n') + '\nnoise\n').repeat(30); // > 3000 chars
    const out = collapseContent(content, 'coder.typecheck');
    expect(out.startsWith('[TypeScript: 360 error(s)]')).toBe(true);
    expect(out.split('\n')).toHaveLength(12); // header + 10 lines + "+350 more"
    expect(out.endsWith('... +350 more')).toBe(true);
  });

  it('keeps up to 16000 chars for read tools, then pages with an offset/limit hint', () => {
    const mid = 'x'.repeat(10_000);
    expect(collapseContent(mid, 'fs.read-file')).toBe(mid); // >3000 but under MAX_READ
    const big = 'y'.repeat(20_000);
    const out = collapseContent(big, 'fs.read-file');
    expect(out.startsWith('y'.repeat(16_000))).toBe(true);
    expect(out).toContain('[...4000 chars collapsed');
  });

  it('collapses long file listings for list/glob tools to 30 lines + count', () => {
    const content = Array.from({ length: 100 }, (_, i) => `file-${i}.ts padding padding padding padding`).join('\n');
    const out = collapseContent(content, 'fs.list');
    expect(out.startsWith('[100 items]')).toBe(true);
    expect(out.endsWith('... +70 more')).toBe(true);
  });

  it('hard-caps unknown tools at 3000 chars with a truncation marker', () => {
    const out = collapseContent('z'.repeat(5000), 'mystery.tool');
    expect(out.startsWith('z'.repeat(3000))).toBe(true);
    expect(out).toContain('[...2000 chars truncated]');
  });
});

// ---------------------------------------------------------------------------
// selectVerbatimTail / selectPinnedGoal
// ---------------------------------------------------------------------------

const msg = (role: BrainMessage['role'], content: string, extra: Partial<BrainMessage> = {}): BrainMessage =>
  ({ role, content, ...extra });

describe('selectVerbatimTail', () => {
  it('drops leading orphan tool results and always retains the latest user message', () => {
    const user = msg('user', 'do the thing');
    const messages: BrainMessage[] = [
      msg('system', 'sys'),
      user,
      msg('assistant', 'calling', { toolCalls: [{ id: 't1', name: 'x', arguments: {} }] }),
      msg('tool', 'result', { toolCallId: 't1' }),
      msg('assistant', 'done'),
    ];
    const tail = selectVerbatimTail(messages, 2);
    // k=2 tail would be [tool, assistant]; the orphan tool head is trimmed and
    // the in-flight user ask is prepended.
    expect(tail).toEqual([user, messages[4]]);
  });

  it('k=0 yields only the last-user invariant, never the full history (slice(-0) bug fixed)', () => {
    // slice(-0) === slice(0) used to return the ENTIRE non-system history,
    // silently defeating summary-only compaction. Fixed: k<=0 → empty slice;
    // the always-retain-last-user invariant still re-adds the in-flight ask.
    const user = msg('user', 'ask');
    const a = msg('assistant', 'a');
    expect(selectVerbatimTail([msg('system', 's'), user, a], 0)).toEqual([user]);
    expect(selectVerbatimTail([msg('system', 's'), a], 0)).toEqual([]);
  });
});

describe('selectPinnedGoal', () => {
  it('pins the first non-empty user message as a prefixed system message', () => {
    const messages = [msg('user', '  '), msg('user', 'real goal'), msg('assistant', 'ok')];
    const pinned = selectPinnedGoal(messages, []);
    expect(pinned).toEqual([{ role: 'system', content: `${PINNED_GOAL_PREFIX}\nreal goal` }]);
  });

  it('carries an existing pin forward instead of re-deriving', () => {
    const pin = msg('system', `${PINNED_GOAL_PREFIX}\noriginal`);
    const pinned = selectPinnedGoal([pin, msg('user', 'newer ask')], []);
    expect(pinned).toEqual([pin]);
  });

  it('returns [] when the first user message is already in the tail, or no user exists', () => {
    const user = msg('user', 'goal');
    expect(selectPinnedGoal([user], [user])).toEqual([]);
    expect(selectPinnedGoal([msg('assistant', 'hi')], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolPairing
// ---------------------------------------------------------------------------

describe('sanitizeToolPairing', () => {
  it('drops a tool result whose declaring assistant is gone', () => {
    const out = sanitizeToolPairing([
      msg('tool', 'orphan', { toolCallId: 'gone' }),
      msg('user', 'hi'),
    ]);
    expect(out).toEqual([msg('user', 'hi')]);
  });

  it('synthesizes a placeholder result right after an assistant whose call has no result', () => {
    const assistant = msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'fs.read', arguments: {} }] });
    const out = sanitizeToolPairing([assistant, msg('assistant', 'after')]);
    expect(out).toEqual([
      assistant,
      { role: 'tool', toolCallId: 'c1', toolName: 'fs.read', content: TRUNCATED_TOOL_RESULT_PLACEHOLDER },
      msg('assistant', 'after'),
    ]);
  });

  it('leaves a correctly paired sequence unchanged (even when the result arrives later)', () => {
    const input = [
      msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] }),
      msg('tool', 'ok', { toolCallId: 'c1' }),
      msg('assistant', 'done'),
    ];
    expect(sanitizeToolPairing(input)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// dropPriorAlignmentAdvisories / trimSessionMessages
// ---------------------------------------------------------------------------

describe('dropPriorAlignmentAdvisories', () => {
  it('removes all [AlignmentAggregator] system messages in place, keeping everything else', () => {
    const keepSys = msg('system', 'task guidance');
    const keepUser = msg('user', '[AlignmentAggregator] quoted by a user — kept');
    const arr = [
      msg('system', '[AlignmentAggregator] advisory 1'),
      keepSys,
      msg('system', '[AlignmentAggregator] advisory 2'),
      keepUser,
    ];
    dropPriorAlignmentAdvisories(arr);
    expect(arr).toEqual([keepSys, keepUser]);
  });
});

describe('trimSessionMessages', () => {
  const state = { sessionId: 's' } as never;

  it('is a no-op at or below the threshold', () => {
    const messages = Array.from({ length: SESSION_MESSAGE_TRIM_THRESHOLD }, (_, i) => msg('user', `m${i}`));
    const session = { messages } as never as Parameters<typeof trimSessionMessages>[0];
    trimSessionMessages(session, state);
    expect(session.messages).toBe(messages); // same array, untouched
  });

  it('keeps all system messages plus the last 20 non-system messages', () => {
    const systems = [msg('system', 'sys1'), msg('system', 'sys2')];
    const nonSystem = Array.from({ length: 45 }, (_, i) => msg('user', `u${i}`));
    const session = { messages: [...systems, ...nonSystem] } as never as Parameters<typeof trimSessionMessages>[0];
    trimSessionMessages(session, state);
    expect(session.messages).toEqual([...systems, ...nonSystem.slice(-SESSION_MESSAGE_KEEP_COUNT)]);
  });
});

// ---------------------------------------------------------------------------
// resolveSemanticPlanCap / semanticPlanAllowed
// ---------------------------------------------------------------------------

describe('resolveSemanticPlanCap', () => {
  it('parses clean non-negative base-10 integers (whitespace trimmed)', () => {
    expect(resolveSemanticPlanCap('5')).toBe(5);
    expect(resolveSemanticPlanCap(' 7 ')).toBe(7);
    expect(resolveSemanticPlanCap('0')).toBe(0); // valid: disables semantic planning
  });

  it('treats everything else as undefined (fail-open, no cap)', () => {
    for (const junk of [undefined, '', '  ', '+5', '-1', '2.9', '0x10', '3x', 'NaN']) {
      expect(resolveSemanticPlanCap(junk)).toBeUndefined();
    }
  });
});

describe('semanticPlanAllowed', () => {
  it('undefined cap means unlimited; numeric cap is strict', () => {
    expect(semanticPlanAllowed(undefined, 9999)).toBe(true);
    expect(semanticPlanAllowed(2, 1)).toBe(true);
    expect(semanticPlanAllowed(2, 2)).toBe(false);
    expect(semanticPlanAllowed(0, 0)).toBe(false); // cap 0 = template-only
  });
});

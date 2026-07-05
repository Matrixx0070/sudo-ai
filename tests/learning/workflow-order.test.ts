/**
 * workflow-order — sequence-based verification (the third repair class). Proves the
 * attributable/covered classification, session isolation, the lookback window, the
 * self-satisfy (files[]) escape, and the reused adoption gate — on synthetic sequences.
 */
import { describe, it, expect } from 'vitest';
import {
  verifyWorkflowOrder, decideWorkflowAdoption, makeGithubCommitOrderRepair,
  makeBrowserSnapshotOrderRepair,
  REPO_EDIT_TOOLS, WORKFLOW_REPAIRS, workflowScanBounds, DEFAULT_WORKFLOW_SCAN_BOUNDS, type ToolEvent,
} from '../../src/core/learning/workflow-order.js';

const repair = makeGithubCommitOrderRepair();
const FAIL = 'Nothing to commit — no changes are staged (you likely called commit before your edits exist).';

// Compact event builder: seconds offset within a session.
const ev = (sessionId: string, tool: string, success: boolean, sec: number, argsRaw?: string): ToolEvent =>
  ({ sessionId, tool, success, errorMessage: success ? '' : FAIL, createdAtMs: sec * 1000, argsRaw });

describe('makeGithubCommitOrderRepair', () => {
  it('targets github.commit / no-changes-staged and treats coder edits as the precondition', () => {
    expect(repair.tool).toBe('github.commit');
    expect(repair.errorPattern).toBe('no changes are staged');
    expect(repair.precondition('coder.write-file')).toBe(true);
    expect(repair.precondition('coder.smart-edit')).toBe(true);
    expect(repair.precondition('coder.read-file')).toBe(false); // a read is not an edit
    expect(REPO_EDIT_TOOLS.has('coder.multi-edit')).toBe(true);
  });
});

describe('verifyWorkflowOrder', () => {
  it('commit with NO preceding repo edit → ATTRIBUTABLE to the ordering mistake', () => {
    const events = [
      ev('s1', 'coder.read-file', true, 1),
      ev('s1', 'coder.multi-read', true, 2),
      ev('s1', 'github.commit', false, 3), // committed without ever writing
    ];
    const r = verifyWorkflowOrder(events, repair);
    expect(r.failures).toBe(1);
    expect(r.attributable).toBe(1);
    expect(r.attributablePct).toBe(100);
  });

  it('commit AFTER a successful repo edit → COVERED (lesson would not help)', () => {
    const events = [
      ev('s1', 'coder.write-file', true, 1), // edit landed
      ev('s1', 'github.commit', false, 2),   // still failed — not an ordering issue
    ];
    const r = verifyWorkflowOrder(events, repair);
    expect(r.failures).toBe(1);
    expect(r.attributable).toBe(0);
    expect(r.covered).toBe(1);
  });

  it('a FAILED edit does not count as a predecessor (must be successful)', () => {
    const events = [ev('s1', 'coder.write-file', false, 1), ev('s1', 'github.commit', false, 2)];
    expect(verifyWorkflowOrder(events, repair).attributable).toBe(1);
  });

  it('an edit OUTSIDE the lookback window does not cover the failure', () => {
    const events = [
      ev('s1', 'coder.write-file', true, 0),          // t=0
      ev('s1', 'github.commit', false, 11 * 60),      // t=11min > 10min window
    ];
    expect(verifyWorkflowOrder(events, repair).attributable).toBe(1);
  });

  it('self-satisfy: a commit carrying files[] is COVERED (single-call write attempt)', () => {
    const events = [ev('s1', 'github.commit', false, 1, JSON.stringify({ files: [{ path: 'a.ts', content: 'x' }] }))];
    expect(verifyWorkflowOrder(events, repair).attributable).toBe(0);
  });

  it('sessions are isolated — an edit in another session does not cover this one', () => {
    const events = [
      ev('other', 'coder.write-file', true, 1),
      ev('s1', 'github.commit', false, 2),
    ];
    const r = verifyWorkflowOrder(events, repair);
    expect(r.attributable).toBe(1);
    expect(r.sessionsSeen).toBe(2);
  });

  it('events with no session are skipped (cannot be sequenced)', () => {
    const events = [{ sessionId: null, tool: 'github.commit', success: false, errorMessage: FAIL, createdAtMs: 1 }];
    expect(verifyWorkflowOrder(events, repair).failures).toBe(0);
  });
});

describe('makeBrowserSnapshotOrderRepair — immediate-predecessor (freshness) semantics', () => {
  const br = makeBrowserSnapshotOrderRepair();
  const REF = 'browser.click: ref=3 not found on the page. The page may have re-rendered since the snapshot.';
  const bev = (tool: string, success: boolean, sec: number): ToolEvent =>
    ({ sessionId: 's', tool, success, errorMessage: success ? '' : REF, createdAtMs: sec * 1000 });

  it('targets the stale-ref cluster and requires an immediate snapshot', () => {
    expect(br.tool).toBe('browser.click');
    expect(br.errorPattern).toBe('not found on the page');
    expect(br.immediatePredecessorOnly).toBe(true);
  });

  it('click IMMEDIATELY after a successful snapshot → COVERED (dynamic re-render, not ordering)', () => {
    const r = verifyWorkflowOrder([bev('browser.snapshot', true, 1), bev('browser.click', false, 5)], br);
    expect(r.attributable).toBe(0);
  });

  it('click immediately after ANOTHER click (no re-snapshot) → ATTRIBUTABLE', () => {
    const r = verifyWorkflowOrder([
      bev('browser.snapshot', true, 1), bev('browser.click', true, 3), bev('browser.click', false, 5),
    ], br);
    expect(r.attributable).toBe(1); // stale ref: the immediate predecessor was a click, not a snapshot
  });

  it('a snapshot EARLIER in the session (but not immediately before) does NOT cover it', () => {
    const r = verifyWorkflowOrder([
      bev('browser.snapshot', true, 1), bev('browser.navigate', true, 3), bev('browser.click', false, 5),
    ], br);
    expect(r.attributable).toBe(1);
  });

  it('a snapshot older than the freshness window does not cover it', () => {
    const r = verifyWorkflowOrder([bev('browser.snapshot', true, 0), bev('browser.click', false, 3 * 60)], br);
    expect(r.attributable).toBe(1);
  });
});

describe('decideWorkflowAdoption (reuses the shared gate)', () => {
  it('adopts only with enough attributable samples AND a high attributable rate', () => {
    expect(decideWorkflowAdoption({ failures: 25, attributable: 24, covered: 1, attributablePct: 96, sessionsSeen: 25 })).toBe('adopt');
    // 20 attributable (≥ floor) but only 50% of failures match → reject.
    expect(decideWorkflowAdoption({ failures: 40, attributable: 20, covered: 20, attributablePct: 50, sessionsSeen: 40 })).toBe('reject');
    expect(decideWorkflowAdoption({ failures: 3, attributable: 3, covered: 0, attributablePct: 100, sessionsSeen: 3 })).toBe('insufficient-data');
  });
  it('registers both ordering repairs', () => {
    const ids = WORKFLOW_REPAIRS.map((r) => r.lessonId);
    expect(ids).toContain('github-commit-before-edit');
    expect(ids).toContain('browser-click-before-snapshot');
  });
});

describe('workflowScanBounds (loader caps)', () => {
  it('defaults when env is unset', () => {
    expect(workflowScanBounds({})).toEqual(DEFAULT_WORKFLOW_SCAN_BOUNDS);
  });
  it('honors env overrides', () => {
    const b = workflowScanBounds({ SUDO_FLYWHEEL_WORKFLOW_DAYS: '7', SUDO_FLYWHEEL_WORKFLOW_MAX_SESSIONS: '50', SUDO_FLYWHEEL_WORKFLOW_MAX_EVENTS: '1000' });
    expect(b).toEqual({ lookbackDays: 7, maxSessions: 50, maxEvents: 1000 });
  });
  it('rejects non-positive / garbage values, falling back to defaults', () => {
    const b = workflowScanBounds({ SUDO_FLYWHEEL_WORKFLOW_DAYS: '0', SUDO_FLYWHEEL_WORKFLOW_MAX_SESSIONS: '-5', SUDO_FLYWHEEL_WORKFLOW_MAX_EVENTS: 'abc' });
    expect(b).toEqual(DEFAULT_WORKFLOW_SCAN_BOUNDS);
  });
});

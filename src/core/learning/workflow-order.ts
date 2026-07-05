/**
 * @file learning/workflow-order.ts
 * @description A THIRD verification mode for the flywheel: workflow-ORDER repairs,
 * verified over trace SEQUENCES rather than single tool inputs.
 *
 * Some failures are neither a bad input (deterministic-rewrite) nor a bad command
 * (guidance live-A/B) — they are an ORDERING mistake: a tool called before its
 * precondition was established. The canonical case is `github.commit` failing with
 * "no changes are staged … you likely called commit before your edits exist" — the
 * agent committed without first writing the file into the repo.
 *
 * You cannot see that from one call's input; you have to look at the SESSION's ordered
 * tool sequence. verifyWorkflowOrder() does exactly that, deterministically and for
 * free (no LLM): for each matching failure it asks "was there a qualifying predecessor
 * (a successful repo-edit) earlier in this session, or did this call satisfy the
 * precondition itself?" If not, the failure is ATTRIBUTABLE to the ordering mistake the
 * lesson addresses. A high attributable fraction means the lesson targets the real
 * cause; a low one means something else is going on and the lesson would not help — so
 * the adoption gate (reused unchanged) rejects it.
 *
 * SAFETY: this only VERIFIES and DECIDES; the lesson it validates goes through the same
 * canary + auto-revert apply path as every other repair (lesson-apply.ts) — nothing
 * here mutates the live agent.
 */
import { decideAdoption, type AdoptionDecision, type AdoptionThresholds, DEFAULT_ADOPTION_THRESHOLDS } from './repair-flywheel-verify.js';

/** One tool call from the trace store, with what sequence analysis needs. */
export interface ToolEvent {
  sessionId: string | null;
  tool: string;
  success: boolean;
  errorMessage: string;
  /** Parsed created_at (ms since epoch) for ordering + lookback. */
  createdAtMs: number;
  argsRaw?: string | null;
}

/** A repair whose validity is a precondition-ordering fact about the session. */
export interface WorkflowOrderRepair {
  lessonId: string;
  /** The tool that fails when the precondition is missing. */
  tool: string;
  lesson: string;
  /** Identifies the target failure cluster in error_message (JS includes + SQL LIKE). */
  errorPattern: string;
  /** A prior SUCCESSFUL call to a tool satisfying this establishes the precondition. */
  precondition: (tool: string) => boolean;
  /** How far back in the same session a qualifying predecessor still counts (ms). */
  lookbackMs: number;
  /** The failing call's own args already satisfy the precondition (e.g. single-call write). */
  selfSatisfies?: (argsRaw: string | null | undefined) => boolean;
  /**
   * When true, ONLY the single immediately-preceding event (within lookback) counts —
   * the precondition must hold *right before* the failing call, not merely somewhere
   * earlier. Fits "freshness" lessons (e.g. snapshot immediately before click) where an
   * intervening action staleness the precondition; the default (any predecessor in the
   * window) fits "presence" lessons (e.g. an edit exists before commit).
   */
  immediatePredecessorOnly?: boolean;
}

export interface WorkflowOrderResult {
  /** Matching cluster failures examined (with a usable session). */
  failures: number;
  /** Failures with NO qualifying predecessor and no self-satisfy — the lesson applies. */
  attributable: number;
  /** Failures already covered by a predecessor / self-satisfy — the lesson would not help. */
  covered: number;
  /** attributable / failures, 0..100. */
  attributablePct: number;
  sessionsSeen: number;
}

/**
 * Verify a workflow-order repair over a set of tool events. Groups by session, orders
 * by time, and classifies each matching failure as attributable or covered. Pure.
 */
export function verifyWorkflowOrder(events: ToolEvent[], repair: WorkflowOrderRepair): WorkflowOrderResult {
  // Group by session (events without a session can't be sequenced — skipped).
  const bySession = new Map<string, ToolEvent[]>();
  for (const e of events) {
    if (!e.sessionId) continue;
    const arr = bySession.get(e.sessionId) ?? [];
    arr.push(e);
    bySession.set(e.sessionId, arr);
  }

  let failures = 0;
  let attributable = 0;
  for (const [, sessionEvents] of bySession) {
    sessionEvents.sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let i = 0; i < sessionEvents.length; i++) {
      const ev = sessionEvents[i]!;
      if (ev.tool !== repair.tool || ev.success || !ev.errorMessage.includes(repair.errorPattern)) continue;
      failures += 1;

      if (repair.selfSatisfies?.(ev.argsRaw)) continue; // covered by its own args
      let covered = false;
      if (repair.immediatePredecessorOnly) {
        // Only the single nearest prior event within the window counts (freshness).
        const prev = i > 0 ? sessionEvents[i - 1]! : undefined;
        covered = !!prev && ev.createdAtMs - prev.createdAtMs <= repair.lookbackMs && prev.success && repair.precondition(prev.tool);
      } else {
        // Any SUCCESSFUL qualifying predecessor within the window (presence).
        for (let j = i - 1; j >= 0; j--) {
          const prev = sessionEvents[j]!;
          if (ev.createdAtMs - prev.createdAtMs > repair.lookbackMs) break; // out of window
          if (prev.success && repair.precondition(prev.tool)) { covered = true; break; }
        }
      }
      if (!covered) attributable += 1;
    }
  }

  return {
    failures,
    attributable,
    covered: failures - attributable,
    attributablePct: failures > 0 ? Math.round((1000 * attributable) / failures) / 10 : 0,
    sessionsSeen: bySession.size,
  };
}

/**
 * Adoption gate for a workflow-order result — reuses the SAME conservative gate as
 * every other repair. Maps onto ReplayVerifyResult: genuine samples = attributable,
 * and the rate that must clear the bar = attributablePct.
 */
export function decideWorkflowAdoption(
  r: WorkflowOrderResult,
  thresholds: AdoptionThresholds = DEFAULT_ADOPTION_THRESHOLDS,
): AdoptionDecision {
  return decideAdoption({ tried: r.failures, alreadyOk: r.covered, recovered: r.attributable, recoveryPct: r.attributablePct }, thresholds);
}

/** Tools whose successful call writes git-visible changes into the repo working tree. */
export const REPO_EDIT_TOOLS = new Set<string>([
  'coder.write-file', 'coder.edit-file', 'coder.smart-edit', 'coder.multi-edit',
  'coder.apply-patch', 'coder.notebook-edit', 'coder.scaffold',
]);

/** The distilled workflow-order lesson for github.commit — single source of truth. */
export const GITHUB_COMMIT_ORDER_LESSON = [
  'Before calling github.commit, make sure your changes actually exist in the repo.',
  'github.commit only commits what is already in `git status` — it does NOT write your',
  'edits for you. So either: (a) pass files:[{path, content}] (or {path, edits:[…]}) to',
  'github.commit to WRITE and commit in one call (preferred when authoring a new PR), or',
  '(b) make your file edits first with a coder edit tool (coder.write-file/edit-file/',
  'smart-edit/multi-edit) so they appear in git status, THEN call github.commit. If you',
  'see "no changes are staged", you committed before your edits landed.',
].join(' ');

/** The github.commit ordering repair, grounded in the tool's own "no changes are staged" error. */
export function makeGithubCommitOrderRepair(): WorkflowOrderRepair {
  return {
    lessonId: 'github-commit-before-edit',
    tool: 'github.commit',
    lesson: GITHUB_COMMIT_ORDER_LESSON,
    errorPattern: 'no changes are staged',
    precondition: (tool) => REPO_EDIT_TOOLS.has(tool),
    lookbackMs: 10 * 60 * 1000, // 10 min — edits earlier in the same session/turn
    // A commit that carried files[] tried to write in one call — ordering wasn't the issue.
    selfSatisfies: (argsRaw) => {
      if (!argsRaw) return false;
      try {
        const o = JSON.parse(argsRaw) as { files?: unknown };
        return Array.isArray(o.files) && o.files.length > 0;
      } catch { return false; }
    },
  };
}

/** The distilled freshness lesson for browser.click — single source of truth. */
export const BROWSER_SNAPSHOT_ORDER_LESSON = [
  'Take a FRESH browser.snapshot immediately before every browser.click. Element refs',
  'come from a snapshot and go stale the moment the page changes — after a navigation,',
  'a previous click, or a dynamic re-render — so a ref from an earlier snapshot may no',
  'longer exist ("ref=N not found on the page"). Always: browser.snapshot → read the',
  'ref you need → browser.click, with nothing in between. If a click reports the ref is',
  'not found, snapshot again and retry with the new ref.',
].join(' ');

/**
 * The browser click-before-snapshot ordering repair. Uses IMMEDIATE-predecessor
 * semantics: a click is covered only if the call right before it was a successful
 * browser.snapshot. NOTE (grounded in real traces): many "ref not found" failures
 * occur DESPITE an immediate snapshot (the page re-rendered on its own), so this lesson
 * is expected to show LOW attributability — the verifier should therefore NOT adopt it,
 * correctly distinguishing a weak ordering lesson from a strong one (github.commit).
 */
export function makeBrowserSnapshotOrderRepair(): WorkflowOrderRepair {
  return {
    lessonId: 'browser-click-before-snapshot',
    tool: 'browser.click',
    lesson: BROWSER_SNAPSHOT_ORDER_LESSON,
    errorPattern: 'not found on the page', // the stale-ref cluster, not timeouts
    precondition: (tool) => tool === 'browser.snapshot',
    lookbackMs: 2 * 60 * 1000, // a snapshot older than ~2 min is stale context
    immediatePredecessorOnly: true,
  };
}

/** Registered workflow-order repairs the flywheel verifies from trace sequences. */
export const WORKFLOW_REPAIRS: WorkflowOrderRepair[] = [
  makeGithubCommitOrderRepair(),
  makeBrowserSnapshotOrderRepair(),
];

/** Loader bounds for the (potentially large) session-event scan. */
export interface WorkflowScanBounds {
  /** Only consider failures/events within this many days (matches trace retention). */
  lookbackDays: number;
  /** Most-recent failing sessions to analyse per repair (also caps the SQL IN-list). */
  maxSessions: number;
  /** Hard backstop on total events loaded per repair; excess is truncated + logged. */
  maxEvents: number;
}

export const DEFAULT_WORKFLOW_SCAN_BOUNDS: WorkflowScanBounds = { lookbackDays: 30, maxSessions: 200, maxEvents: 50_000 };

/** Resolve scan bounds from env (SUDO_FLYWHEEL_WORKFLOW_*), clamped to sane positives. */
export function workflowScanBounds(env: NodeJS.ProcessEnv = process.env): WorkflowScanBounds {
  const pos = (raw: string | undefined, dflt: number): number => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    lookbackDays: pos(env['SUDO_FLYWHEEL_WORKFLOW_DAYS'], DEFAULT_WORKFLOW_SCAN_BOUNDS.lookbackDays),
    maxSessions: pos(env['SUDO_FLYWHEEL_WORKFLOW_MAX_SESSIONS'], DEFAULT_WORKFLOW_SCAN_BOUNDS.maxSessions),
    maxEvents: pos(env['SUDO_FLYWHEEL_WORKFLOW_MAX_EVENTS'], DEFAULT_WORKFLOW_SCAN_BOUNDS.maxEvents),
  };
}

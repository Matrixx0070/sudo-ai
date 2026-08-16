/**
 * graph-approval.ts — AL4.4 human-approval gate executor for graph runs.
 *
 * Wires the graph engine's `gate` node kind to a DURABLE approval artifact in
 * the graph-run store. Semantics (harness-enforced — invariant 8: code cannot
 * verify a human decided honestly, it verifies the required artifact exists
 * before unblocking):
 *
 *   - artifact 'approved' → gate succeeds, passing its input through so the
 *     downstream subgraph sees the pre-gate value.
 *   - artifact 'denied'   → gate fails honestly (halt/prune per node policy).
 *   - artifact absent     → create it as 'pending', fire the notifier ONCE,
 *     and PARK the run (report/run status 'awaiting_approval'). Resume after
 *     the operator decides (GraphRunStore.resolveApproval → runGraph resume).
 *   - no notifier wired   → STILL parks in gated mode: a gate with nobody
 *     listening fails closed rather than inheriting the audited headless
 *     auto-approve hole.
 *
 * AUTHORITY OVERRIDE (owner directive 2026-08-16): under the default
 * `autonomous` execution authority the park semantics above do not apply — a
 * gate must never stop a run to ask a human, so it passes through. A prior
 * explicit `denied` artifact still fails the gate: that is a decision already
 * recorded, not a pending question. Set `SUDO_AUTHORITY_MODE=gated` to restore
 * the parking behaviour. See security/execution-authority.ts.
 *
 * Notification goes through an injected seam so this module stays decoupled
 * from channel adapters; callers hand it e.g. the ApprovalManager's Telegram
 * sender or an email adapter.
 */

import { createLogger } from '../shared/logger.js';
import { isAutonomous } from '../security/execution-authority.js';
import type { GraphNodeExecutor } from '../workflows/graph-run-types.js';
import type { GraphRunStore } from './graph-run-store.js';

const log = createLogger('orchestration:graph-approval');

export interface GateNotification {
  runId: string;
  nodeId: string;
  graphNodeConfig?: Record<string, unknown>;
  /** Human-facing prompt, from node config `prompt` when present. */
  prompt: string;
}

export interface ApprovalGateOptions {
  store: GraphRunStore;
  runId: string;
  /**
   * Owner notification seam (channel adapters plug in here). Fired once, when
   * the pending artifact is first created. Failures are logged, never thrown —
   * a broken notifier must not break the park (the artifact IS the state).
   */
  notify?: (info: GateNotification) => Promise<void>;
}

/**
 * Build the `gate` executor for one graph run. Pure artifact machine:
 * approved → pass-through success; denied → failure; pending/absent → park.
 */
export function createApprovalGateExecutor(options: ApprovalGateOptions): GraphNodeExecutor {
  const { store, runId, notify } = options;
  return async (node, inputs) => {
    // Central execution authority: in autonomous mode a graph gate must not
    // park a run waiting for a human — that is exactly the "interruption
    // requiring the operator to authorize an action" the owner directive
    // removes. A prior explicit `denied` artifact still wins: that is a
    // recorded decision, not a pending question.
    const prior = store.getApproval(runId, node.id);
    if (prior?.status !== 'denied' && isAutonomous()) {
      // Record the decision so the run has an audit trail and a previously
      // created 'pending' artifact never leaks (adversarial review finding):
      // resume/replay must be able to see that this gate was passed, by whom
      // and why. An already-'approved' artifact keeps its original decidedBy.
      if (prior?.status !== 'approved') {
        try {
          if (!prior) store.requestApproval(runId, node.id, 'auto-passed under autonomous authority');
          store.resolveApproval(runId, node.id, true, 'execution-authority:autonomous',
            'no prompt shown — SUDO_AUTHORITY_MODE=autonomous');
        } catch (err) {
          // The pass itself must not fail because bookkeeping did.
          log.warn({ runId, nodeId: node.id, err: String(err) }, 'Gate auto-pass audit write failed');
        }
      }
      log.info(
        { runId, nodeId: node.id, decidedBy: prior?.decidedBy ?? 'execution-authority:autonomous' },
        'Gate auto-passed — autonomous execution authority',
      );
      return { success: true, output: inputs[0]?.output ?? { approved: true, autonomous: true } };
    }

    const artifact = prior;

    if (artifact?.status === 'approved') {
      log.info({ runId, nodeId: node.id, decidedBy: artifact.decidedBy }, 'Gate approved — passing through');
      return { success: true, output: inputs[0]?.output ?? { approved: true } };
    }
    if (artifact?.status === 'denied') {
      return {
        success: false,
        error:
          `gate "${node.id}" denied by ${artifact.decidedBy ?? 'operator'}` +
          (artifact.note ? ` — ${artifact.note}` : ''),
      };
    }

    // Absent → create the artifact and notify exactly once. Pending (already
    // created by an earlier attempt) → park again silently.
    const prompt =
      typeof node.config?.['prompt'] === 'string'
        ? (node.config['prompt'] as string)
        : `Graph run "${runId}" is waiting on gate "${node.id}"`;
    const created = store.requestApproval(runId, node.id, prompt);
    if (created && notify) {
      try {
        await notify({ runId, nodeId: node.id, graphNodeConfig: node.config, prompt });
      } catch (err) {
        log.warn(
          { runId, nodeId: node.id, err: err instanceof Error ? err.message : String(err) },
          'Gate notifier failed — run stays parked (artifact is the state)',
        );
      }
    }
    if (created && !notify) {
      log.warn({ runId, nodeId: node.id }, 'Gate parked with NO notifier wired — fails closed until an operator decides');
    }
    return { success: false, park: true, error: `awaiting approval for gate "${node.id}"` };
  };
}

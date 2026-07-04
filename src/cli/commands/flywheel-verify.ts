/**
 * @file cli/commands/flywheel-verify.ts
 * @description `sudo-ai flywheel-verify` — run the repair-flywheel LIVE A/B on demand.
 *
 * This is the explicit, gated entry point for the guidance-repair verifier
 * (repair-flywheel-verify-live.ts). It replays the REAL captured failing tool
 * inputs from traces.db through a candidate guidance lesson: a live LLM rewrites
 * each refused command, and the true-to-prod guard decides whether the rewrite
 * would be accepted. It then reports adopt / reject / insufficient-data.
 *
 * COST GATE (deliberate): a live run spends real tokens (one full brain call per
 * genuine failure). So the DEFAULT is a FREE dry run — it counts, using the guard
 * only (no LLM), exactly how many genuine failures a live run would spend tokens
 * on — and prints how to execute. The live run happens ONLY with `--confirm`
 * (or SUDO_FLYWHEEL_LIVE_AB=1). Nothing is ever applied to the live agent — this
 * VERIFIES and DECIDES; adoption is a separate, still-unwired gate.
 *
 * Options:
 *   --tool <name>  Tool cluster to verify (default: system.exec)
 *   --max <n>      Max live rewrites to spend (cost ceiling, default: 20)
 *   --confirm      Actually spend tokens and run the live A/B
 *   --json         Emit the result as JSON
 *
 * Exit 0 on a clean run (dry or live); 2 on bad input (unknown tool / no corpus).
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../../core/shared/logger.js';
import { DATA_DIR } from '../../core/shared/paths.js';
import {
  replayVerifyLive,
  decideLiveAdoption,
  makeExecRepoRepair,
  buildRewritePrompt,
  parseRewriteReply,
  type GuidanceRepair,
  type LlmRewrite,
  type LiveReplayResult,
} from '../../core/learning/repair-flywheel-verify-live.js';

const log = createLogger('cli:flywheel-verify');

export interface FlywheelVerifyOpts {
  tool?: string;
  max?: string;
  confirm?: boolean;
  json?: boolean;
  admit?: boolean;
}

/** Registry of guidance repairs the CLI can verify, keyed by their tool cluster. */
function resolveRepair(tool: string): GuidanceRepair | null {
  switch (tool) {
    case 'system.exec':
      return makeExecRepoRepair();
    default:
      return null;
  }
}

/** Read the captured FAILING inputs for a tool from traces.db (read-only). */
function loadFailingInputs(tool: string): Array<Record<string, unknown>> {
  const dbPath = path.join(DATA_DIR, 'traces.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        "SELECT args_raw FROM traces WHERE tool_name=? AND success=0 AND args_raw IS NOT NULL AND args_raw != ''",
      )
      .all(tool) as Array<{ args_raw: string }>;
    const inputs: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      try {
        const o = JSON.parse(r.args_raw) as unknown;
        if (o && typeof o === 'object' && !Array.isArray(o)) inputs.push(o as Record<string, unknown>);
      } catch { /* unparseable — skip */ }
    }
    return inputs;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function printReport(repair: GuidanceRepair, r: LiveReplayResult, live: boolean, json: boolean): void {
  const decision = decideLiveAdoption(r);
  if (json) {
    console.log(JSON.stringify(
      { tool: repair.tool, lessonId: repair.lessonId, live, applicable: r.applicable, alreadyOk: r.alreadyOk, recovered: r.recovered, impossible: r.impossible, recoveryPct: r.recoveryPct, decision, episodes: r.episodes },
      null, 2,
    ));
    return;
  }
  const genuine = r.applicable - r.alreadyOk;
  console.log(`\n=== flywheel-verify: ${repair.lessonId} (${repair.tool}) ${live ? '[LIVE]' : '[DRY]'} ===`);
  console.log(`  applicable captured failures : ${r.applicable}`);
  console.log(`  already-ok (non-guard fails) : ${r.alreadyOk}`);
  console.log(`  genuine guard refusals       : ${genuine}`);
  if (live) {
    console.log(`  recovered by lesson          : ${r.recovered}`);
    console.log(`  impossible (correctly refused): ${r.impossible}`);
    console.log(`  recovery                     : ${r.recoveryPct}%  (upper bound — guard-accept, not semantic-equiv)`);
    console.log(`  DECISION                     : ${decision}`);
    if (r.episodes.length > 0) {
      console.log('\n  episodes:');
      for (const e of r.episodes) {
        console.log(`    ${e.recovered ? 'RECOVERED' : 'no       '} | ${e.original.slice(0, 64).replace(/\n/g, ' ')}  ->  ${e.rewrite ?? 'IMPOSSIBLE'}`);
      }
    }
  } else {
    console.log(`\n  A live run would make up to ${genuine} LLM rewrites (one full brain call each).`);
    console.log('  Re-run with --confirm (or SUDO_FLYWHEEL_LIVE_AB=1) to spend tokens and get the decision.');
  }
}

export async function runFlywheelVerify(opts: FlywheelVerifyOpts): Promise<number> {
  const tool = opts.tool ?? 'system.exec';
  const maxEpisodes = Math.max(1, Number.parseInt(opts.max ?? '20', 10) || 20);
  const repair = resolveRepair(tool);
  if (!repair) {
    console.error(`[flywheel-verify] no guidance repair registered for tool '${tool}' (known: system.exec)`);
    return 2;
  }

  let inputs: Array<Record<string, unknown>>;
  try {
    inputs = loadFailingInputs(tool);
  } catch (err) {
    console.error(`[flywheel-verify] could not read traces.db: ${String(err)}`);
    console.error('[flywheel-verify] need captured tool inputs (SUDO_TRACE_CAPTURE=1) and a populated corpus.');
    return 2;
  }
  if (inputs.length === 0) {
    console.error(`[flywheel-verify] no captured failing inputs for '${tool}' yet (corpus building).`);
    return 2;
  }

  const confirmed = opts.confirm === true || process.env['SUDO_FLYWHEEL_LIVE_AB'] === '1';

  if (!confirmed) {
    // FREE dry run: a null rewrite (declare-IMPOSSIBLE) spends no tokens but yields
    // the exact applicable / already-ok / genuine accounting the live run would use.
    const dry = await replayVerifyLive(inputs, repair, async () => null, { maxEpisodes });
    printReport(repair, dry, false, opts.json ?? false);
    return 0;
  }

  // Live run — spends real tokens. Build the brain the same way the daemon does.
  const { ConfigLoader } = await import('../../core/config/loader.js');
  const { Brain } = await import('../../core/brain/brain.js');
  const loader = new ConfigLoader();
  await loader.load();
  const brain = new Brain(loader.get());
  log.info({ tool, maxEpisodes }, 'flywheel-verify: running LIVE A/B (spending tokens)');

  const rewrite: LlmRewrite = async ({ lesson, original, reason }) => {
    const reply = await brain.chat([{ role: 'user', content: buildRewritePrompt(lesson, original, reason) }]);
    return parseRewriteReply(reply);
  };
  const result = await replayVerifyLive(inputs, repair, rewrite, { maxEpisodes });
  printReport(repair, result, true, opts.json ?? false);

  // Close the loop: on an 'adopt' decision, optionally ADMIT the lesson as a canary
  // candidate (explicit --admit only). The scanner then rolls it out behind a canary
  // that auto-reverts on non-improvement (needs SUDO_FLYWHEEL_APPLY=1 to take effect).
  const decision = decideLiveAdoption(result);
  if (decision === 'adopt' && opts.admit === true) {
    const { loadLessonStore, saveLessonStore, upsertCandidate } = await import('../../core/learning/lesson-store.js');
    const { lessonStorePath, isApplyEnabled } = await import('../../core/learning/lesson-apply.js');
    const now = new Date().toISOString();
    const store = loadLessonStore(lessonStorePath());
    const { store: next, added } = upsertCandidate(store, {
      lessonId: repair.lessonId, tool: repair.tool, hint: repair.lesson,
      recoveryPct: result.recoveryPct, canaryWindowMs: 24 * 60 * 60 * 1000,
    }, now);
    if (added) {
      saveLessonStore(lessonStorePath(), next);
      console.log(`\n  ADMITTED '${repair.lessonId}' as a canary candidate.`);
      console.log(isApplyEnabled()
        ? '  SUDO_FLYWHEEL_APPLY=1 is set — the scanner will start the canary next cycle.'
        : '  Set SUDO_FLYWHEEL_APPLY=1 for the scanner to roll it out (auto-reverts on non-improvement).');
    } else {
      console.log(`\n  '${repair.lessonId}' is already tracked — not re-admitted.`);
    }
  } else if (decision === 'adopt') {
    console.log('\n  decision=adopt — re-run with --admit to enter it into the canary lifecycle.');
  }
  return 0;
}

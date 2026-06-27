/**
 * @file arsenal-v2/index.ts
 * @description `coder.arsenal-v2` — surgical patch-driven coding agent.
 *
 * The successor to `coder.arsenal`. Replaces v1's full-file-rewrite output
 * with the patch operations defined in {@link ./patch-types.ts}. Three
 * concrete wins over v1:
 *
 *   1. Scales to large files: output tokens scale with edit size, not file
 *      size, so a single-line fix in a 3000-line file is no harder than in a
 *      50-line file.
 *   2. Drift-detected: every str_replace / insert_* verifies the anchor in
 *      the CURRENT file content. A stale plan from an old read gets skipped
 *      rather than corrupting the file.
 *   3. Per-file isolated: one file's failure doesn't abort the others.
 *
 * Slice 2 scope (this module): recon -> LLM -> parse -> apply -> tsc verify
 * -> structured report. Single-model selection (no cascade — slice 4 work).
 * Critic loop and related-tests verification come in slices 3-4.
 */

import { generateText, streamText } from 'ai';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT } from '../../../../shared/paths.js';
import { getModel } from '../../../../brain/providers.js';
import { clampMaxTokensToModel } from '../../../../brain/thinking-inject.js';
import { modelForAttempt, parseCascade } from './cascade.js';
import {
  DEFAULT_MODE_SIMILARITY,
  effectiveSimilarity,
  loadRecentStatsByMode,
  parseModeSimilarityEnv,
  rankCascade,
  weightedCollapseByMode,
} from './stats.js';
import { runCritic, type CriticResult } from './critic.js';
import { buildDiffSummary } from './diff-summary.js';
import { applyPatches } from './patch-applier.js';
import { parsePatchBlock } from './patch-parser.js';
import type { ApplyResult } from './patch-types.js';
import { recon } from './recon.js';
import { readAutoRevertEnabled, revertAttempts, type RevertResult } from './revert.js';
import {
  buildRetryAppendix,
  clampMaxAttempts,
  shouldRetry,
  type PreviousAttempt,
} from './retry-prompt.js';
import {
  type ArsenalV2Mode,
  buildSystemPrompt,
  isMutatingMode,
} from './system-prompt.js';
import { recordAttempt } from './telemetry.js';
import { runRelatedTests, type VerifyResult } from './verify.js';

const logger = createLogger('coder.arsenal-v2');

const BACKUP_ROOT = path.join(PROJECT_ROOT, 'data', 'arsenal-v2-backups');
const TELEMETRY_PATH = path.join(PROJECT_ROOT, 'data', 'arsenal-v2-telemetry.jsonl');
const TSC = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc');

const SUPPORTED_MODES: readonly ArsenalV2Mode[] = ['fix', 'build', 'refactor', 'test', 'review', 'analyze', 'explain'];

/**
 * Default model when neither task forces one nor SUDO_ARSENAL_V2_MODEL is set.
 * Opus is the only model the claude.ai OAuth endpoint serves reliably — *every*
 * Sonnet id (4-6 and the dated 4-5) stalls there with no response headers
 * (undici HeadersTimeoutError), so they surfaced as "arsenal: model failed".
 * Don't use a claude-oauth Sonnet id here.
 */
const DEFAULT_MODEL = 'claude-oauth/claude-opus-4-8';

interface TscResult {
  clean: boolean;
  errorCount: number;
  summary: string;
}

/** One iteration of the retry loop — captured for the report + retry prompt. */
interface AttemptRecord {
  index: number;
  /** Patcher model id used for this attempt (per-attempt due to slice-6 cascade). */
  model: string;
  applyResult: ApplyResult;
  applied: number;
  skipped: number;
  failed: number;
  tscAfter: TscResult;
  testResult: VerifyResult | null;
  criticResult: CriticResult | null;
  diffSummary: string;
  /** Wall-clock ms for this attempt (LLM call + apply + tsc + tests + critic). */
  durationMs: number;
  /**
   * Per-attempt success bool — same shape as the final tool success. Lifted
   * onto the record so the post-loop auto-revert decision (all-attempts-fail
   * trigger) doesn't have to re-derive it from the constituent fields.
   */
  attemptSuccess: boolean;
}

function runTsc(): TscResult {
  if (!existsSync(TSC)) return { clean: true, errorCount: 0, summary: '(tsc not available — skipped)' };
  try {
    execFileSync(TSC, ['--noEmit'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 512 * 1024,
    });
    return { clean: true, errorCount: 0, summary: 'TypeScript: clean ✓' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    let raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    // Sanitize CRLF and ANSI escape codes to prevent injection into LLM prompt
    raw = raw.replace(/\r\n/g, '\n').replace(/\x1B\[[0-9;]*m/g, '');
    const matches = raw.match(/error TS\d+/g);
    const count = matches?.length ?? 0;
    const firstTen = raw.split('\n').filter((l) => l.includes('error TS')).slice(0, 10);
    return {
      clean: false,
      errorCount: count,
      summary: `TypeScript: ${count} error(s)\n${firstTen.join('\n')}`,
    };
  }
}

async function callLLM(modelId: string, system: string, user: string): Promise<string> {
  const model = getModel(modelId);
  // streamText avoids the undici HeadersTimeout that plagued v1 on large
  // bodies — the server responds with stream headers immediately and we
  // accumulate text as it arrives.
  // Clamp to the model's output ceiling (opus-4-8 → 32000) so the AI SDK doesn't
  // warn on every call; behaviour-identical (the SDK clamps anyway), no-op for
  // non-opus. DEFAULT_MODEL is opus-4-8, so this path warned without the clamp.
  const stream = await streamText({ model, system, prompt: user, maxOutputTokens: clampMaxTokensToModel(modelId, 32_768, { modelMax: process.env['SUDO_THINKING_MODEL_MAX'] }) });
  let buf = '';
  for await (const chunk of stream.textStream) buf += chunk;
  return buf;
}

export const arsenalV2Tool: ToolDefinition = {
  name: 'coder.arsenal-v2',
  description:
    'Patch-driven autonomous coding agent. Reads relevant files, generates surgical edits as a JSON patch block (str_replace / insert_after / insert_before / create_file / delete_file), applies them atomically per file with drift detection, runs tsc, and reports per-file outcomes. ' +
    'Modes: fix (root-cause bug fixes), build (new feature/module), refactor (preserve behavior, improve quality), test (write exhaustive tests), review (read-only security + architecture audit), analyze (read-only deep analysis), explain (read-only walkthrough). ' +
    'Successor to coder.arsenal — scales to large files where the older tool hit output-token caps.',
  category: 'coder',
  timeout: 300_000,
  parameters: {
    task: {
      type: 'string',
      required: true,
      description: 'What to do. Be specific: include the bug symptom / acceptance criteria / files involved.',
    },
    mode: {
      type: 'string',
      enum: [...SUPPORTED_MODES] as string[],
      description: 'Operation mode. Default: "fix".',
    },
    files: {
      type: 'array',
      description: 'Optional explicit file or directory paths (project-relative). When omitted, recon discovers relevant files.',
    },
    context: {
      type: 'string',
      description: 'Additional context: stack traces, error messages, constraints, prior attempts.',
    },
    applyEdits: {
      type: 'boolean',
      description: 'Write changes to disk. Default: true for mutating modes (fix/build/refactor/test), false for read-only modes (review/analyze/explain). Set false to dry-run a mutating mode.',
    },
    model: {
      type: 'string',
      description: 'Force a specific model id (e.g. "claude-oauth/claude-opus-4-8"). Single-model fallback; superseded by `models` when both are set. Default: SUDO_ARSENAL_V2_MODEL env var, else "claude-oauth/claude-opus-4-8".',
    },
    models: {
      type: 'array',
      description: 'Cascade — ordered list of model ids, one per retry attempt. Attempt 1 uses models[0]; attempt 2 uses models[1]; beyond the list the last entry is reused. Overrides `model` and SUDO_ARSENAL_V2_CASCADE env when set.',
    },
    maxAttempts: {
      type: 'number',
      description: 'Maximum patch attempts when the critic returns NEEDS_REVISION. Clamped to [1, 5]. Default: SUDO_ARSENAL_V2_MAX_ATTEMPTS env var, else 3. Set to 1 to disable the retry loop.',
    },
    telemetry: {
      type: 'boolean',
      description: 'Write one JSONL row per attempt to data/arsenal-v2-telemetry.jsonl. Default: true unless SUDO_ARSENAL_V2_TELEMETRY=0.',
    },
    reorder: {
      type: 'boolean',
      description: 'Reorder the cascade by recent approval rate (read from data/arsenal-v2-telemetry.jsonl, 7-day window). Default: true unless SUDO_ARSENAL_V2_NO_REORDER=1.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = typeof params['task'] === 'string' ? params['task'].trim() : '';
    if (!task) return { success: false, output: 'coder.arsenal-v2: "task" is required.' };

    const modeRaw = typeof params['mode'] === 'string' ? params['mode'].trim() : 'fix';
    if (!SUPPORTED_MODES.includes(modeRaw as ArsenalV2Mode)) {
      return { success: false, output: `coder.arsenal-v2: unknown mode "${modeRaw}". Supported: ${SUPPORTED_MODES.join(', ')}.` };
    }
    const mode = modeRaw as ArsenalV2Mode;
    const mutating = isMutatingMode(mode);
    const shouldApply =
      typeof params['applyEdits'] === 'boolean' ? (params['applyEdits'] as boolean) : mutating;
    const filesParam = Array.isArray(params['files']) ? (params['files'] as string[]) : [];
    const context = typeof params['context'] === 'string' ? params['context'].trim() : '';
    const forcedModel = typeof params['model'] === 'string' ? params['model'].trim() : '';

    // Model cascade — one entry per retry attempt; last entry repeats. The
    // cascade collapses to a single-element list when only `model` / env are
    // set, which preserves slice-5 behavior (same model every attempt).
    const cascadeOriginal = parseCascade({
      models: params['models'],
      model: forcedModel,
      envCascade: process.env['SUDO_ARSENAL_V2_CASCADE'],
      envModel: process.env['SUDO_ARSENAL_V2_MODEL'],
      defaultModel: DEFAULT_MODEL,
    });

    // Reorder by recent approval rate when the cascade has more than one
    // model and reordering isn't disabled. Reads the slice-6 telemetry
    // JSONL — empty / missing → no-op, original order preserved.
    const reorderEnabled =
      params['reorder'] === false
        ? false
        : process.env['SUDO_ARSENAL_V2_NO_REORDER'] === '1'
          ? false
          : true;
    const statsWindowMs = Number(process.env['SUDO_ARSENAL_V2_STATS_WINDOW_MS']);
    const halfLifeMs = Number(process.env['SUDO_ARSENAL_V2_STATS_HALF_LIFE_MS']);
    const shrinkageK = Number(process.env['SUDO_ARSENAL_V2_STATS_SHRINKAGE_K']);
    const cascade = (() => {
      if (!reorderEnabled || cascadeOriginal.length <= 1) return cascadeOriginal;
      // One file walk produces per-mode buckets; weightedCollapseByMode
      // derives the slice-12 similarity-weighted global view without a
      // second read. Empty mode bucket + empty global = "all unknown"
      // → declared order preserved (slice-7 contract).
      const byMode = loadRecentStatsByMode({
        path: TELEMETRY_PATH,
        windowMs: Number.isFinite(statsWindowMs) && statsWindowMs > 0 ? statsWindowMs : undefined,
        halfLifeMs: Number.isFinite(halfLifeMs) && halfLifeMs > 0 ? halfLifeMs : undefined,
      });
      const modeStats = byMode.get(mode) ?? new Map();
      const envMatrix = parseModeSimilarityEnv(process.env['SUDO_ARSENAL_V2_MODE_SIMILARITY']);
      const baseMatrix = envMatrix ?? DEFAULT_MODE_SIMILARITY;
      // Slice 13: blend the hand-crafted prior with empirical Pearson
      // similarity. Opt-out drops back to the slice-12 static matrix.
      const dataDrivenEnabled = process.env['SUDO_ARSENAL_V2_NO_DATA_SIMILARITY'] !== '1';
      const simShrinkageK = Number(process.env['SUDO_ARSENAL_V2_SIM_SHRINKAGE_K']);
      const corrMethodRaw = process.env['SUDO_ARSENAL_V2_CORR_METHOD'];
      const corrMethod = corrMethodRaw === 'spearman' ? 'spearman' : undefined; // anything else → default 'pearson'
      const simMatrix = dataDrivenEnabled
        ? effectiveSimilarity(byMode, baseMatrix, {
            shrinkageK: Number.isFinite(simShrinkageK) && simShrinkageK > 0 ? simShrinkageK : undefined,
            method: corrMethod,
          })
        : baseMatrix;
      const globalStats = weightedCollapseByMode(byMode, mode, simMatrix);
      return rankCascade(cascadeOriginal, modeStats, {
        globalStats,
        modeShrinkageK: Number.isFinite(shrinkageK) && shrinkageK > 0 ? shrinkageK : undefined,
      });
    })();
    const cascadeReordered =
      cascade.length === cascadeOriginal.length &&
      cascade.some((m, i) => m !== cascadeOriginal[i]);

    // Retry-loop budget. Tool param wins; otherwise env; otherwise the
    // clampMaxAttempts default (3). Always clamped to [1, 5].
    const maxAttempts = clampMaxAttempts(
      params['maxAttempts'] ?? process.env['SUDO_ARSENAL_V2_MAX_ATTEMPTS'],
    );

    // Telemetry opt-out. Tool param wins; falls back to env-controlled
    // behavior in recordAttempt itself.
    const telemetryEnabled = params['telemetry'] === false ? false : true;

    logger.info(
      {
        session: ctx.sessionId,
        mode,
        mutating,
        shouldApply,
        cascade,
        cascadeOriginal,
        cascadeReordered,
        reorderEnabled,
        maxAttempts,
        telemetry: telemetryEnabled,
        explicitFiles: filesParam.length,
      },
      'coder.arsenal-v2 invoked',
    );

    // ---- 1. Recon — gather relevant source files ----
    const reconTask = filesParam.length > 0 ? `${task}\nFiles: ${filesParam.join(', ')}` : task;
    let reconResult = await recon(reconTask, { projectRoot: PROJECT_ROOT, searchRoot: PROJECT_ROOT });
    if (reconResult.files.length === 0) {
      return { success: false, output: 'coder.arsenal-v2: recon found no source files to load.' };
    }
    logger.info({ files: reconResult.files.length, bytes: reconResult.totalBytes, truncation: reconResult.truncationReason }, 'recon complete');

    // ---- 2. Baseline tsc (mutating modes only) ----
    const baseline = shouldApply && mutating ? runTsc() : null;

    // ---- 3. Build prompt + call LLM (attempt 1, model = cascade[0]) ----
    const firstModel = modelForAttempt(cascade, 1);
    const systemPrompt = buildSystemPrompt(mode);
    const buildUserPrompt = (payload: string, retryAppendix: string): string =>
      [
        `TASK: ${task}`,
        context ? `\nADDITIONAL CONTEXT:\n${context}` : '',
        baseline && !baseline.clean ? `\nBASELINE: ${baseline.errorCount} TypeScript errors exist before your changes.` : '',
        `\n\nCODE TO WORK ON:\n${payload}`,
        retryAppendix,
      ].filter(Boolean).join('');

    const firstAttemptStart = Date.now();
    let aiText: string;
    try {
      aiText = await callLLM(firstModel, systemPrompt, buildUserPrompt(reconResult.payload, ''));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ model: firstModel, err: msg }, 'LLM call failed');
      return { success: false, output: `coder.arsenal-v2: LLM call failed (${firstModel}): ${msg.slice(0, 200)}` };
    }
    if (!aiText.trim()) {
      return { success: false, output: `coder.arsenal-v2: LLM (${firstModel}) returned empty response.` };
    }

    // ---- 4. Read-only modes return the model's text directly ----
    if (!mutating) {
      return {
        success: true,
        output: `**[coder.arsenal-v2 — ${firstModel} — ${mode}]**\n\n${aiText.trim()}`,
        data: { model: firstModel, mode, files: reconResult.files },
      };
    }

    // ---- 5. Dry-run short-circuit (parse only; don't enter the retry loop) ----
    if (!shouldApply) {
      const parsed = parsePatchBlock(aiText);
      if (!parsed.ok) {
        return {
          success: false,
          output: [
            `coder.arsenal-v2: patch parse failed — ${parsed.error}`,
            '',
            '--- Raw LLM response (first 2000 chars) ---',
            aiText.slice(0, 2000),
          ].join('\n'),
          data: { model: firstModel, mode, parseError: parsed.error },
        };
      }
      return {
        success: true,
        output: [
          `**[coder.arsenal-v2 — ${firstModel} — ${mode} — DRY RUN]**`,
          '',
          `Would apply ${parsed.ops.length} op(s):`,
          ...parsed.ops.map((o) => `  • ${o.op} → ${o.file}`),
        ].join('\n'),
        data: { model: firstModel, mode, dryRun: true, ops: parsed.ops },
      };
    }

    // ---- 6. Retry loop: parse → apply → tsc → tests → critic; on
    //        critic=needs_revision and budget remaining, re-invoke patcher
    //        with the prior diff + critique appended to the user prompt.
    //        Each attempt uses modelForAttempt(cascade, idx).
    const criticModelId = process.env['SUDO_ARSENAL_V2_CRITIC_MODEL'] || firstModel;
    const telemetryPath = TELEMETRY_PATH;
    const attempts: AttemptRecord[] = [];
    const previousForPrompt: PreviousAttempt[] = [];
    let attemptIdx = 1;
    let currentAiText = aiText;
    let currentModel = firstModel;
    let attemptStartedAt = firstAttemptStart;
    let loopAbortReason: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parsed = parsePatchBlock(currentAiText);
      if (!parsed.ok) {
        if (attemptIdx === 1) {
          return {
            success: false,
            output: [
              `coder.arsenal-v2: patch parse failed — ${parsed.error}`,
              '',
              '--- Raw LLM response (first 2000 chars) ---',
              currentAiText.slice(0, 2000),
            ].join('\n'),
            data: { model: currentModel, mode, parseError: parsed.error },
          };
        }
        loopAbortReason = `parse_failed_on_attempt_${attemptIdx}: ${parsed.error}`;
        break;
      }
      logger.info({ attempt: attemptIdx, model: currentModel, ops: parsed.ops.length }, 'patch block parsed');

      const applyResult = applyPatches(parsed.ops, { projectRoot: PROJECT_ROOT, backupRoot: BACKUP_ROOT });
      const applied = applyResult.results.filter((r) => r.status === 'applied').length;
      const skipped = applyResult.results.filter((r) => r.status === 'skipped').length;
      const failed = applyResult.results.filter((r) => r.status === 'failed').length;
      logger.info({ attempt: attemptIdx, model: currentModel, applied, skipped, failed, backupDir: applyResult.backupDir }, 'patches applied');

      const after = runTsc();

      const testResult = applied > 0
        ? runRelatedTests(applyResult.filesWritten, { projectRoot: PROJECT_ROOT })
        : null;

      const diffSummary = applied > 0 ? buildDiffSummary(applyResult.results) : '';

      const criticResult = applied > 0
        ? await runCritic({
            task,
            mode,
            diffSummary,
            tscSummary: after.summary,
            testSummary: testResult ? testResult.summary : null,
            llm: ({ modelId: mId, system, user }) => callLLM(mId, system, user),
            modelId: criticModelId,
          })
        : null;

      const durationMs = Date.now() - attemptStartedAt;

      // Per-attempt success same shape as the final success bool — used to
      // make the telemetry row's "success" interpretable in aggregate later
      // AND to drive the post-loop all-attempts-fail revert trigger.
      const attemptTscOk = after.clean || (baseline ? after.errorCount < baseline.errorCount : true);
      const attemptTestsOk = !testResult || testResult.skipped || testResult.passed;
      const attemptCriticOk = !criticResult || criticResult.skipped || criticResult.verdict === 'approve';
      const attemptSuccess = failed === 0 && attemptTscOk && attemptTestsOk && attemptCriticOk;

      attempts.push({
        index: attemptIdx,
        model: currentModel,
        applyResult,
        applied,
        skipped,
        failed,
        tscAfter: after,
        testResult,
        criticResult,
        diffSummary,
        durationMs,
        attemptSuccess,
      });

      if (telemetryEnabled) {
        recordAttempt(
          {
            ts: Date.now(),
            sessionId: ctx.sessionId,
            mode,
            attemptIndex: attemptIdx,
            maxAttempts,
            model: currentModel,
            applied,
            skipped,
            failed,
            tscClean: after.clean,
            tscErrorCount: after.errorCount,
            testsPassed: testResult ? testResult.passed : null,
            criticVerdict: criticResult?.verdict ?? null,
            success: attemptSuccess,
            durationMs,
          },
          { path: telemetryPath },
        );
      }

      // Check for unrecoverable drift: all operations were skipped due to file changes
      // In this case, retrying won't help — the files don't match the LLM's plan anymore
      if (applied === 0 && skipped > 0 && failed === 0 && parsed.ops.length > 0) {
        loopAbortReason = `all_ops_skipped_drift_detected_on_attempt_${attemptIdx}`;
        break;
      }

      const retry = shouldRetry({
        criticVerdict: criticResult?.verdict ?? null,
        criticSkipped: criticResult?.skipped ?? true,
        attemptIndex: attemptIdx,
        maxAttempts,
        applied,
      });
      if (!retry) break;

      // Prep the next iteration: record this attempt for the appendix,
      // refresh recon against the now-mutated files, escalate the model,
      // ask the patcher again.
      previousForPrompt.push({ diffSummary, critique: criticResult?.critique ?? '' });
      try {
        reconResult = await recon(reconTask, { projectRoot: PROJECT_ROOT, searchRoot: PROJECT_ROOT });
      } catch (err) {
        loopAbortReason = `recon_failed_after_attempt_${attemptIdx}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
        break;
      }
      const nextPrompt = buildUserPrompt(reconResult.payload, buildRetryAppendix(previousForPrompt));

      attemptIdx += 1;
      currentModel = modelForAttempt(cascade, attemptIdx);
      attemptStartedAt = Date.now();
      try {
        currentAiText = await callLLM(currentModel, systemPrompt, nextPrompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ attempt: attemptIdx, model: currentModel, err: msg }, 'retry LLM call failed; using prior attempt result');
        loopAbortReason = `llm_failed_on_attempt_${attemptIdx}: ${msg.slice(0, 200)}`;
        attemptIdx -= 1;
        break;
      }
      if (!currentAiText.trim()) {
        loopAbortReason = `llm_empty_on_attempt_${attemptIdx}`;
        attemptIdx -= 1;
        break;
      }
    }

    // ---- 7. Build structured report from the LAST attempt ----
    // attempts.length is guaranteed >= 1 because attempt 1's parse path
    // either bails early (return above) or pushes a record.
    const final = attempts[attempts.length - 1]!;
    const { applyResult, applied, skipped, failed, tscAfter: after, testResult, criticResult } = final;

    const finalModel = final.model;
    const lines: string[] = [`**[coder.arsenal-v2 — ${finalModel} — ${mode}]**`, ''];
    lines.push('## Patches');
    for (const r of applyResult.results) {
      const status = r.status === 'applied' ? '✓' : r.status === 'skipped' ? '↷' : '✗';
      const reason = r.reason ? ` (${r.reason})` : '';
      lines.push(`  ${status} ${r.op.op} → ${r.op.file}${reason}${r.detail ? `  — ${r.detail}` : ''}`);
    }
    lines.push('');

    if (baseline) {
      lines.push('## TypeScript');
      lines.push(`  Before: ${baseline.errorCount} error(s)`);
      lines.push(`  After:  ${after.errorCount} error(s) ${after.clean ? '✓ CLEAN' : after.errorCount < baseline.errorCount ? '(improved)' : '⚠'}`);
      if (!after.clean) { lines.push(''); lines.push(after.summary); }
      lines.push('');
    }

    if (testResult) {
      lines.push('## Tests');
      lines.push(`  ${testResult.summary.split('\n')[0]}`);
      if (testResult.ran && !testResult.passed) {
        const rest = testResult.summary.split('\n').slice(1);
        for (const l of rest) lines.push(`  ${l}`);
      }
      lines.push('');
    }

    if (criticResult) {
      const verdictGlyph =
        criticResult.verdict === 'approve' ? '✓' : criticResult.verdict === 'needs_revision' ? '⚠' : '✗';
      lines.push('## Critic');
      lines.push(`  Verdict: ${verdictGlyph} ${criticResult.verdict.toUpperCase()} (${criticResult.modelId})`);
      if (criticResult.verdict === 'error') {
        logger.warn({ model: criticResult.modelId }, 'critic verdict returned error — safety net bypassed, changes approved anyway');
      }
      if (criticResult.critique) {
        for (const l of criticResult.critique.split('\n')) lines.push(`  ${l}`);
      }
      lines.push('');
    }

    if (attempts.length > 1 || loopAbortReason) {
      lines.push('## Attempts');
      for (const a of attempts) {
        const v = a.criticResult?.verdict ?? 'no-critic';
        lines.push(`  Attempt ${a.index}/${maxAttempts} [${a.model}]: ${a.applied} applied, ${a.skipped} skipped, ${a.failed} failed — critic=${v} (${a.durationMs}ms)`);
      }
      if (loopAbortReason) lines.push(`  Aborted: ${loopAbortReason}`);
      lines.push('');
    }

    if (cascadeReordered) {
      lines.push('## Cascade');
      lines.push(`  Declared: [${cascadeOriginal.join(', ')}]`);
      lines.push(`  Active:   [${cascade.join(', ')}]`);
      lines.push(`  (reordered by recent ${mode}-mode approval rate from telemetry)`);
      lines.push('');
    }

    lines.push(`## Backups`);
    lines.push(`  ${applyResult.backupDir}`);
    lines.push('');

    const tscOk = after.clean || (baseline ? after.errorCount < baseline.errorCount : true);
    const testsOk = !testResult || testResult.skipped || testResult.passed;
    // Critic blocks tool success only when it ran and returned needs_revision.
    // An 'error' verdict (LLM call failed or output malformed) does NOT block —
    // graceful degrade, matching how tsc / tests treat their own skip paths.
    const criticOk = !criticResult || criticResult.skipped || criticResult.verdict === 'approve';
    const success = failed === 0 && tscOk && testsOk && criticOk;

    // Auto-revert on all-attempts-fail (opt-in via SUDO_ARSENAL_V2_AUTO_REVERT=1).
    // Trigger: the run as a whole failed AND every individual attempt also
    // failed by its own success criteria. A partial improvement (e.g. tsc
    // errors dropped attempt 1 but everything broke attempt 2) is left on
    // disk — the operator can still use per-attempt backup dirs manually.
    // Disabled by default: a tool that mutates user code should not also
    // auto-delete those mutations without an explicit operator decision.
    const autoRevertEnabled = readAutoRevertEnabled(process.env);
    const allAttemptsFailed =
      !success && attempts.length > 0 && attempts.every((a) => !a.attemptSuccess);
    let revertResult: RevertResult | null = null;
    if (allAttemptsFailed && autoRevertEnabled) {
      revertResult = revertAttempts(attempts, { projectRoot: PROJECT_ROOT });
      logger.warn(
        {
          restored: revertResult.restored,
          deleted: revertResult.deleted,
          failed: revertResult.failed,
          attempts: attempts.length,
        },
        'arsenal-v2: all attempts failed — auto-revert ran',
      );
      lines.push('## Revert');
      lines.push(
        `  All ${attempts.length} attempt(s) failed; SUDO_ARSENAL_V2_AUTO_REVERT=1 active.`,
      );
      lines.push(
        `  Restored: ${revertResult.restored} file(s), Deleted: ${revertResult.deleted} file(s), Failed: ${revertResult.failed} file(s).`,
      );
      if (revertResult.errors.length > 0) {
        for (const e of revertResult.errors.slice(0, 5)) lines.push(`    ✗ ${e}`);
        if (revertResult.errors.length > 5) {
          lines.push(`    … +${revertResult.errors.length - 5} more (see logs)`);
        }
      }
      lines.push('');
    }
    return {
      success,
      output: lines.join('\n'),
      data: {
        model: finalModel,
        cascade,
        cascadeOriginal,
        cascadeReordered,
        modelsUsed: attempts.map((a) => a.model),
        mode,
        filesWritten: applyResult.filesWritten,
        filesDeleted: applyResult.filesDeleted,
        opsApplied: applied,
        opsSkipped: skipped,
        opsFailed: failed,
        backupDir: applyResult.backupDir,
        typeErrorsBefore: baseline?.errorCount ?? null,
        typeErrorsAfter: after.errorCount,
        typesClean: after.clean,
        testsRan: testResult?.ran ?? false,
        testsPassed: testResult?.passed ?? null,
        testsRun: testResult?.testsRun ?? null,
        testFailures: testResult?.failures ?? null,
        testSkipReason: testResult?.skipReason ?? null,
        criticRan: criticResult?.ran ?? false,
        criticVerdict: criticResult?.verdict ?? null,
        criticModel: criticResult?.modelId ?? null,
        criticSkipReason: criticResult?.skipReason ?? null,
        attempts: attempts.length,
        maxAttempts,
        attemptVerdicts: attempts.map((a) => a.criticResult?.verdict ?? null),
        loopAbortReason,
        telemetryEnabled,
        autoRevertEnabled,
        reverted: revertResult !== null,
        // Split restored vs deleted so the data shape matches the existing
        // paired-counter convention (opsApplied / opsSkipped / opsFailed).
        // Verifier LOW-1.
        revertedRestored: revertResult?.restored ?? 0,
        revertedDeleted: revertResult?.deleted ?? 0,
        revertedFailed: revertResult?.failed ?? 0,
      },
    };
  },
};

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
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT } from '../../../../shared/paths.js';
import { getModel } from '../../../../brain/providers.js';
import { runCritic } from './critic.js';
import { buildDiffSummary } from './diff-summary.js';
import { applyPatches } from './patch-applier.js';
import { parsePatchBlock } from './patch-parser.js';
import { recon } from './recon.js';
import {
  type ArsenalV2Mode,
  buildSystemPrompt,
  isMutatingMode,
} from './system-prompt.js';
import { runRelatedTests } from './verify.js';

const logger = createLogger('coder.arsenal-v2');

const BACKUP_ROOT = path.join(PROJECT_ROOT, 'data', 'arsenal-v2-backups');
const TSC = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc');

const SUPPORTED_MODES: readonly ArsenalV2Mode[] = ['fix', 'build', 'refactor', 'test', 'review', 'analyze', 'explain'];

/** Default model when neither task forces one nor SUDO_ARSENAL_V2_MODEL is set. */
const DEFAULT_MODEL = 'claude-oauth/claude-sonnet-4-6';

interface TscResult {
  clean: boolean;
  errorCount: number;
  summary: string;
}

function runTsc(): TscResult {
  if (!existsSync(TSC)) return { clean: true, errorCount: 0, summary: '(tsc not available — skipped)' };
  try {
    execSync(`"${TSC}" --noEmit`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { clean: true, errorCount: 0, summary: 'TypeScript: clean ✓' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
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
  const stream = await streamText({ model, system, prompt: user, maxOutputTokens: 32_768 });
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
      description: 'Force a specific model id (e.g. "claude-oauth/claude-sonnet-4-6"). Default: SUDO_ARSENAL_V2_MODEL env var, else "claude-oauth/claude-sonnet-4-6".',
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
    const modelId = forcedModel || process.env['SUDO_ARSENAL_V2_MODEL'] || DEFAULT_MODEL;

    logger.info(
      { session: ctx.sessionId, mode, mutating, shouldApply, modelId, explicitFiles: filesParam.length },
      'coder.arsenal-v2 invoked',
    );

    // ---- 1. Recon — gather relevant source files ----
    const reconTask = filesParam.length > 0 ? `${task}\nFiles: ${filesParam.join(', ')}` : task;
    const reconResult = await recon(reconTask, { projectRoot: PROJECT_ROOT, searchRoot: PROJECT_ROOT });
    if (reconResult.files.length === 0) {
      return { success: false, output: 'coder.arsenal-v2: recon found no source files to load.' };
    }
    logger.info({ files: reconResult.files.length, bytes: reconResult.totalBytes, truncation: reconResult.truncationReason }, 'recon complete');

    // ---- 2. Baseline tsc (mutating modes only) ----
    const baseline = shouldApply && mutating ? runTsc() : null;

    // ---- 3. Build prompt + call LLM ----
    const systemPrompt = buildSystemPrompt(mode);
    const userPrompt = [
      `TASK: ${task}`,
      context ? `\nADDITIONAL CONTEXT:\n${context}` : '',
      baseline && !baseline.clean ? `\nBASELINE: ${baseline.errorCount} TypeScript errors exist before your changes.` : '',
      `\n\nCODE TO WORK ON:\n${reconResult.payload}`,
    ].filter(Boolean).join('');

    let aiText: string;
    try {
      aiText = await callLLM(modelId, systemPrompt, userPrompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ modelId, err: msg }, 'LLM call failed');
      return { success: false, output: `coder.arsenal-v2: LLM call failed (${modelId}): ${msg.slice(0, 200)}` };
    }
    if (!aiText.trim()) {
      return { success: false, output: `coder.arsenal-v2: LLM (${modelId}) returned empty response.` };
    }

    // ---- 4. Read-only modes return the model's text directly ----
    if (!mutating) {
      return {
        success: true,
        output: `**[coder.arsenal-v2 — ${modelId} — ${mode}]**\n\n${aiText.trim()}`,
        data: { model: modelId, mode, files: reconResult.files },
      };
    }

    // ---- 5. Parse the PATCH block ----
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
        data: { model: modelId, mode, parseError: parsed.error },
      };
    }
    logger.info({ ops: parsed.ops.length }, 'patch block parsed');

    // ---- 6. Apply (or skip when dry-run) ----
    if (!shouldApply) {
      return {
        success: true,
        output: [
          `**[coder.arsenal-v2 — ${modelId} — ${mode} — DRY RUN]**`,
          '',
          `Would apply ${parsed.ops.length} op(s):`,
          ...parsed.ops.map((o) => `  • ${o.op} → ${o.file}`),
        ].join('\n'),
        data: { model: modelId, mode, dryRun: true, ops: parsed.ops },
      };
    }

    const applyResult = applyPatches(parsed.ops, { projectRoot: PROJECT_ROOT, backupRoot: BACKUP_ROOT });
    const applied = applyResult.results.filter((r) => r.status === 'applied').length;
    const skipped = applyResult.results.filter((r) => r.status === 'skipped').length;
    const failed = applyResult.results.filter((r) => r.status === 'failed').length;
    logger.info({ applied, skipped, failed, backupDir: applyResult.backupDir }, 'patches applied');

    // ---- 7. Re-run tsc to verify ----
    const after = runTsc();

    // ---- 7b. Run vitest --related on patch-touched files ----
    // Test failures are surfaced in the report but do NOT abort — matches how
    // tsc errors are handled. Tool success still requires opsFailed === 0 and
    // a non-regressed tsc, plus (when tests ran) a clean test result.
    const testResult = applied > 0
      ? runRelatedTests(applyResult.filesWritten, { projectRoot: PROJECT_ROOT })
      : null;

    // ---- 7c. Critic — second-pass LLM review of the applied diff ----
    const criticModelId =
      process.env['SUDO_ARSENAL_V2_CRITIC_MODEL'] || modelId;
    const criticResult =
      applied > 0
        ? await runCritic({
            task,
            mode,
            diffSummary: buildDiffSummary(applyResult.results),
            tscSummary: after.summary,
            testSummary: testResult ? testResult.summary : null,
            llm: ({ modelId: mId, system, user }) => callLLM(mId, system, user),
            modelId: criticModelId,
          })
        : null;

    // ---- 8. Build structured report ----
    const lines: string[] = [`**[coder.arsenal-v2 — ${modelId} — ${mode}]**`, ''];
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
      if (criticResult.critique) {
        for (const l of criticResult.critique.split('\n')) lines.push(`  ${l}`);
      }
      lines.push('');
    }

    lines.push(`## Backups`);
    lines.push(`  ${applyResult.backupDir}`);

    const tscOk = after.clean || (baseline ? after.errorCount < baseline.errorCount : true);
    const testsOk = !testResult || testResult.skipped || testResult.passed;
    // Critic blocks tool success only when it ran and returned needs_revision.
    // An 'error' verdict (LLM call failed or output malformed) does NOT block —
    // graceful degrade, matching how tsc / tests treat their own skip paths.
    const criticOk = !criticResult || criticResult.skipped || criticResult.verdict === 'approve';
    const success = failed === 0 && tscOk && testsOk && criticOk;
    return {
      success,
      output: lines.join('\n'),
      data: {
        model: modelId,
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
      },
    };
  },
};

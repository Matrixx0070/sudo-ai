/**
 * coder.swarm — Parallel multi-agent coding executor.
 *
 * Splits large tasks into independent subtasks and runs each as a separate
 * Grok 4 call simultaneously via Promise.allSettled(). Merges all results,
 * applies all file edits (later subtasks win on conflicts), then runs a
 * single tsc verification pass.
 *
 * Model: Grok 4 (grok-4-0709) with grok-4-1-fast-reasoning fallback.
 */

import { generateText } from 'ai';
import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, copyFileSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getModel } from '../../../brain/providers.js';
import { PROJECT_ROOT as RESOLVED_PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('coder.swarm');
const PROJECT_ROOT = RESOLVED_PROJECT_ROOT;
const TSC = path.join(PROJECT_ROOT, 'node_modules/.bin/tsc');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'data', 'arsenal-backups');

// ---------------------------------------------------------------------------
// Model cascade (swarm uses two models)
// ---------------------------------------------------------------------------

const SWARM_MODELS = [
  { model: 'xai/grok-4-0709',             label: 'Grok 4 (2M ctx)'     },
  { model: 'xai/grok-4-1-fast-reasoning', label: 'Grok Fast Reasoning'  },
  { model: 'claude-oauth/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (OAuth)' },
  { model: 'google/gemini-2.5-flash',     label: 'Gemini 2.5 Flash'     },
];

// ---------------------------------------------------------------------------
// Subtask system prompt
// ---------------------------------------------------------------------------

const SUBTASK_SYSTEM = `You are an elite software engineer. Fix the specific task given.
Output changed files in this EXACT format:
<<<FILE: relative/path/to/file.ts>>>
[complete file content]
<<<END>>>
<<<SUMMARY>>>
What was fixed.
<<<END>>>`;

const DECOMPOSE_SYSTEM = `You are a task decomposer. Split the given coding task into 2-4 independent parallel subtasks. Each subtask must be independent (no dependency on another subtask's output). Return JSON array: [{"task": string, "files": string[], "rationale": string}]`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Subtask {
  task: string;
  files: string[];
  rationale?: string;
}

interface ParsedEdit {
  filePath: string;
  content: string;
}

interface SubtaskResult {
  subtask: Subtask;
  success: boolean;
  filesChanged: string[];
  summary: string;
  error?: string;
}

interface TscResult {
  clean: boolean;
  errorCount: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Semaphore for concurrency limiting
// ---------------------------------------------------------------------------

function makeSemaphore(count: number) {
  const sem = { count };
  async function withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    while (sem.count <= 0) await new Promise<void>(r => setTimeout(r, 100));
    sem.count--;
    try { return await fn(); } finally { sem.count++; }
  }
  return withSemaphore;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolveProjectPath(p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(PROJECT_ROOT, p);
}

function createBackup(abs: string): void {
  try {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const rel = path.relative(PROJECT_ROOT, abs).replace(/[\\/]/g, '__');
    const dest = path.join(BACKUP_DIR, `${Date.now()}_${rel}`);
    if (existsSync(abs)) copyFileSync(abs, dest);
  } catch { /* non-fatal */ }
}

function readSpecificFiles(filePaths: string[]): string {
  const parts: string[] = [];
  for (const fp of filePaths) {
    const abs = resolveProjectPath(fp);
    if (!existsSync(abs)) { parts.push(`### ${fp}\n[FILE NOT FOUND]\n\n`); continue; }
    try {
      const s = statSync(abs);
      if (s.size > 80_000) { parts.push(`### ${fp}\n[FILE TOO LARGE — ${s.size} bytes]\n\n`); continue; }
      const content = readFileSync(abs, 'utf-8');
      const rel = path.relative(PROJECT_ROOT, abs);
      parts.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\`\n\n`);
    } catch { parts.push(`### ${fp}\n[CANNOT READ]\n\n`); }
  }
  return parts.join('');
}

function parseEdits(text: string): { edits: ParsedEdit[]; summary: string } {
  const edits: ParsedEdit[] = [];
  const fileRegex = /<<<FILE:\s*([^\n>]+)>>>\n([\s\S]*?)<<<END>>>/g;
  let m: RegExpExecArray | null;
  while ((m = fileRegex.exec(text)) !== null) {
    const filePath = (m[1] ?? '').trim();
    let content = (m[2] ?? '').trim();
    content = content.replace(/^```[^\n]*\n/, '').replace(/\n```$/, '');
    if (filePath && content) edits.push({ filePath, content });
  }
  const summaryMatch = text.match(/<<<SUMMARY>>>([\s\S]*?)<<<END>>>/);
  const summary = summaryMatch ? (summaryMatch[1] ?? '').trim() : '';
  return { edits, summary };
}

function applyEdits(edits: ParsedEdit[]): { applied: string[]; failed: string[] } {
  const applied: string[] = [];
  const failed: string[] = [];
  for (const edit of edits) {
    const abs = resolveProjectPath(edit.filePath);
    if (!abs.startsWith(PROJECT_ROOT)) {
      failed.push(`${edit.filePath} (path traversal blocked)`);
      continue;
    }
    try {
      createBackup(abs);
      const dir = path.dirname(abs);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, edit.content, 'utf-8');
      const rel = path.relative(PROJECT_ROOT, abs);
      applied.push(rel);
      logger.info({ path: rel }, 'swarm: file written');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push(`${edit.filePath}: ${msg}`);
    }
  }
  return { applied, failed };
}

function runTsc(): TscResult {
  if (!existsSync(TSC)) return { clean: true, errorCount: 0, summary: '(tsc not available)' };
  try {
    execSync(`"${TSC}" --noEmit`, {
      cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { clean: true, errorCount: 0, summary: 'TypeScript: clean' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const raw = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
    const matches = raw.match(/error TS\d+/g);
    const count = matches?.length ?? 0;
    const lines = raw.split('\n').filter(l => l.includes('error TS')).slice(0, 10);
    return { clean: false, errorCount: count, summary: `TypeScript: ${count} error(s)\n${lines.join('\n')}` };
  }
}

// ---------------------------------------------------------------------------
// Call a single Grok model with cascade fallback
// ---------------------------------------------------------------------------

async function callModel(system: string, prompt: string): Promise<string> {
  const errors: string[] = [];
  for (const option of SWARM_MODELS) {
    try {
      const model = getModel(option.model);
      const result = await generateText({
        model,
        system,
        prompt,
        maxOutputTokens: 32768,
        temperature: 0.3,
      });
      const text = result.text?.trim() ?? '';
      if (!text) { errors.push(`${option.label}: empty response`); continue; }
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not configured') || msg.includes('API key')) continue;
      errors.push(`${option.label}: ${msg.slice(0, 80)}`);
    }
  }
  throw new Error(`All models failed: ${errors.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Auto-decompose a task into subtasks
// ---------------------------------------------------------------------------

async function decomposeTask(task: string, globalFiles: string[]): Promise<Subtask[]> {
  try {
    const prompt = `Task: ${task}\n\nAvailable files context: ${globalFiles.slice(0, 20).join(', ')}`;
    const text = await callModel(DECOMPOSE_SYSTEM, prompt);

    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');

    const raw = JSON.parse(jsonMatch[0]) as unknown;
    if (!Array.isArray(raw)) throw new Error('Not an array');

    const subtasks: Subtask[] = [];
    for (const item of raw) {
      if (typeof item === 'object' && item !== null && 'task' in item) {
        const s = item as Record<string, unknown>;
        subtasks.push({
          task: String(s['task'] ?? ''),
          files: Array.isArray(s['files']) ? (s['files'] as string[]) : [],
          rationale: typeof s['rationale'] === 'string' ? s['rationale'] : undefined,
        });
      }
    }

    if (subtasks.length === 0) throw new Error('Empty subtask array');
    logger.info({ count: subtasks.length }, 'swarm: decomposed task');
    return subtasks;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'swarm: decompose failed, using single subtask');
    return [{ task, files: globalFiles }];
  }
}

// ---------------------------------------------------------------------------
// Execute a single subtask
// ---------------------------------------------------------------------------

async function executeSubtask(subtask: Subtask, context: string): Promise<SubtaskResult> {
  const fileContext = subtask.files.length > 0 ? readSpecificFiles(subtask.files) : '';
  const prompt = [
    `TASK: ${subtask.task}`,
    context ? `\nCONTEXT:\n${context}` : '',
    fileContext ? `\n\nCODE:\n${fileContext}` : '',
  ].filter(Boolean).join('');

  try {
    const text = await callModel(SUBTASK_SYSTEM, prompt);
    const { edits, summary } = parseEdits(text);
    const { applied, failed } = applyEdits(edits);

    logger.info({
      subtask: subtask.task.slice(0, 60),
      applied: applied.length,
      failed: failed.length,
    }, 'swarm: subtask done');

    return {
      subtask,
      success: failed.length === 0,
      filesChanged: applied,
      summary: summary || `Applied ${applied.length} file(s).`,
      error: failed.length > 0 ? `Failed files: ${failed.join(', ')}` : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ subtask: subtask.task.slice(0, 60), err: msg }, 'swarm: subtask error');
    return {
      subtask,
      success: false,
      filesChanged: [],
      summary: '',
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const swarmTool: ToolDefinition = {
  name: 'coder.swarm',
  description:
    'Parallel multi-agent coding executor — splits large tasks into independent subtasks and runs them ' +
    'simultaneously with Grok 4. Up to 4x faster than sequential execution for multi-file tasks. ' +
    'Use for: fixing errors across multiple modules, building a feature with frontend+backend+tests as ' +
    'parallel streams, large refactors across many files. ' +
    'Provide task + either subtasks array OR let Grok auto-decompose.',
  category: 'coder',
  timeout: 600_000, // 10 minutes

  parameters: {
    task: {
      type: 'string',
      required: true,
      description: 'The overall task to accomplish.',
    },
    subtasks: {
      type: 'array',
      description:
        'Optional: manually specify subtasks. Each: { task: string, files: string[] }. ' +
        'If omitted, Grok auto-decomposes the main task into parallel workstreams.',
    },
    files: {
      type: 'array',
      description: 'Files/dirs relevant to the overall task.',
    },
    context: {
      type: 'string',
      description: 'Additional context.',
    },
    maxParallel: {
      type: 'number',
      description: 'Max parallel agents (default: 3, max: 5).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task       = typeof params['task']       === 'string' ? params['task'].trim()       : '';
    const context    = typeof params['context']    === 'string' ? params['context'].trim()    : '';
    const rawFiles   = Array.isArray(params['files'])    ? (params['files']    as string[])   : [];
    const rawSubs    = Array.isArray(params['subtasks'])  ? (params['subtasks'] as unknown[])  : [];
    const maxP       = typeof params['maxParallel'] === 'number'
      ? Math.min(Math.max(1, params['maxParallel']), 5)
      : 3;

    if (!task) {
      return { success: false, output: 'coder.swarm: "task" is required.' };
    }

    logger.info({ session: ctx.sessionId, maxParallel: maxP, hasSubs: rawSubs.length > 0 }, 'coder.swarm invoked');

    // ---- STEP 1: Resolve subtasks ----
    let subtasks: Subtask[];

    if (rawSubs.length > 0) {
      // Manually provided subtasks
      subtasks = rawSubs
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map(s => ({
          task: typeof s['task'] === 'string' ? s['task'] : '',
          files: Array.isArray(s['files']) ? (s['files'] as string[]) : [],
          rationale: typeof s['rationale'] === 'string' ? s['rationale'] : undefined,
        }))
        .filter(s => s.task.length > 0);
    } else {
      // Auto-decompose
      subtasks = await decomposeTask(task, rawFiles);
    }

    if (subtasks.length === 0) {
      return { success: false, output: 'coder.swarm: Could not determine subtasks.' };
    }

    // ---- STEP 2: Run subtasks in parallel with semaphore ----
    const withSemaphore = makeSemaphore(maxP);

    const settledResults = await Promise.allSettled(
      subtasks.map(st =>
        withSemaphore(() => executeSubtask(st, context))
      )
    );

    const subtaskResults: SubtaskResult[] = settledResults.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        subtask: subtasks[i]!,
        success: false,
        filesChanged: [],
        summary: '',
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    // ---- STEP 3: Run tsc once after all edits ----
    const tsc = runTsc();
    logger.info({ errors: tsc.errorCount }, 'swarm: post-merge tsc');

    // ---- STEP 4: Build report ----
    const allFilesChanged = [...new Set(subtaskResults.flatMap(r => r.filesChanged))];
    const failedSubs = subtaskResults.filter(r => !r.success);
    const success = failedSubs.length === 0 && tsc.clean;

    const reportLines: string[] = [
      `**[CODER.SWARM — ${subtasks.length} agents — ${maxP} parallel]**`,
      '',
      `## Results: ${subtaskResults.filter(r => r.success).length}/${subtasks.length} subtasks succeeded`,
      '',
    ];

    for (let i = 0; i < subtaskResults.length; i++) {
      const r = subtaskResults[i]!;
      const status = r.success ? 'OK' : 'FAIL';
      reportLines.push(`### Subtask ${i + 1} [${status}]: ${r.subtask.task.slice(0, 80)}`);
      if (r.subtask.rationale) reportLines.push(`_Rationale: ${r.subtask.rationale}_`);
      if (r.filesChanged.length > 0) {
        reportLines.push(`Files changed: ${r.filesChanged.join(', ')}`);
      }
      if (r.summary) reportLines.push(`Summary: ${r.summary}`);
      if (r.error) reportLines.push(`Error: ${r.error}`);
      reportLines.push('');
    }

    if (allFilesChanged.length > 0) {
      reportLines.push(`## All Files Modified (${allFilesChanged.length})`);
      for (const f of allFilesChanged) reportLines.push(`  - ${f}`);
      reportLines.push('');
    }

    reportLines.push('## TypeScript Status');
    reportLines.push(tsc.summary);
    if (!tsc.clean) {
      const lines = tsc.summary.split('\n').slice(1).join('\n');
      if (lines) reportLines.push(lines);
    }

    return {
      success,
      output: reportLines.join('\n'),
      data: {
        subtaskCount: subtasks.length,
        succeeded: subtaskResults.filter(r => r.success).length,
        failed: failedSubs.length,
        filesChanged: allFilesChanged,
        tscClean: tsc.clean,
        tscErrors: tsc.errorCount,
      },
    };
  },
};

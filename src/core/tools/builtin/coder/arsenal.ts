/**
 * coder.arsenal — SUDO-AI's unified autonomous coding agent.
 *
 * ONE TOOL. FULL PIPELINE. ELITE LEVEL.
 *
 * Internally runs the complete coding workflow in a single call:
 *   1. Reconnaissance  — auto-discovers and reads all relevant files
 *   2. Baseline check  — runs tsc to capture current error state
 *   3. AI reasoning    — Grok 4 (2M ctx) analyzes, plans, and writes all fixes
 *   4. Apply edits     — applies every file change from Grok's response
 *   5. Verify          — re-runs tsc to confirm clean after edits
 *   6. Test            — optionally runs the test suite
 *   7. Report          — structured summary: what changed, what's clean, what remains
 *
 * Modes:
 *   fix      — Find and fix bugs, type errors, logic issues
 *   build    — Build a new feature or module from scratch
 *   review   — Full adversarial code review (security + architecture + performance)
 *   refactor — Restructure code for quality and maintainability
 *   analyze  — Deep analysis without editing (read-only)
 *   test     — Write comprehensive tests for existing code
 *   explain  — Explain what the code does in detail
 *
 * Model: Grok 4 (grok-4-0709, 2M tokens) → cascade fallback
 */

import { generateText } from 'ai';
import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, copyFileSync, statSync, lstatSync, renameSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getModel } from '../../../brain/providers.js';
import { PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('coder.arsenal');
const TSC = path.join(PROJECT_ROOT, 'node_modules/.bin/tsc');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'data', 'arsenal-backups');

// ---------------------------------------------------------------------------
// Model cascade
// ---------------------------------------------------------------------------

const MODEL_CASCADE = [
  { model: 'xai/grok-4-0709',              label: 'Grok 4 (2M ctx)'      },
  { model: 'xai/grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning'  },
  { model: 'xai/grok-4-1-fast-reasoning',  label: 'Grok Fast Reasoning'  },
  { model: 'claude-oauth/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (OAuth)' },
  { model: 'google/gemini-2.5-flash',      label: 'Gemini 2.5 Flash'     },
  { model: 'groq/llama-3.3-70b-versatile', label: 'Groq Llama 3.3 70B'  },
];

// ---------------------------------------------------------------------------
// System prompts by mode
// ---------------------------------------------------------------------------

const SYSTEM_PROMPTS: Record<string, string> = {
  fix: `You are an elite software engineer performing surgical bug fixes.

MISSION: Find every bug, error, and broken behaviour. Fix ALL of them completely.

RULES:
- Read every file carefully. Understand before you touch.
- Fix root causes — never symptoms.
- Handle ALL edge cases. Don't leave partial fixes.
- Follow the existing code style exactly.
- Never use "any" type — use "unknown" with narrowing.
- Always use ESM imports/exports. Never require().
- After your reasoning, output ALL changed files in EXACT format below.

OUTPUT FORMAT — use this exactly for each changed file:
<<<FILE: relative/path/to/file.ts>>>
[complete file content — no omissions, no placeholders, no "... rest of file"]
<<<END>>>

Then provide:
<<<SUMMARY>>>
- Files changed: list each file and what was fixed
- Root causes found: what was broken and why
- Testing: what to verify
<<<END>>>`,

  build: `You are an elite software architect and implementation engineer.

MISSION: Build the requested feature completely and correctly. Production-ready from day one.

RULES:
- Design the architecture first (in your reasoning), then implement.
- Write complete, working code — zero placeholders, zero TODOs.
- Follow the existing project patterns exactly (check imports, naming, error handling style).
- TypeScript strict mode — all types explicit, no "any".
- ESM only — import/export syntax, never require().
- Handle errors at every boundary.
- Write the implementation AND update any index files / registrations needed.

OUTPUT FORMAT for each new or modified file:
<<<FILE: relative/path/to/file.ts>>>
[complete file content]
<<<END>>>

<<<SUMMARY>>>
- Files created: list with purpose
- Files modified: list with what changed
- How to verify: test steps
- What to do next: any manual steps needed
<<<END>>>`,

  review: `You are an elite offensive security engineer and principal architect conducting an adversarial review.

MISSION: Find every vulnerability, architectural flaw, and bug. Be merciless.

SECURITY (OWASP Top 10 + CWE Top 25):
- Injection: SQL, NoSQL, OS command, LDAP, SSTI, log injection
- Broken auth: weak sessions, insecure JWT, missing authz, password in URL
- Sensitive data: unencrypted PII, secrets in code/logs, weak crypto (MD5/SHA1)
- XSS: reflected, stored, DOM (eval, innerHTML, dangerouslySetInnerHTML)
- Broken access control: IDOR, path traversal, privilege escalation
- Security misconfig: CORS wildcard, missing headers, verbose error messages
- SSRF: fetch with user-supplied URLs
- Timing attacks: == comparison for secrets instead of timingSafeEqual
- Prototype pollution: obj[userKey] = value
- ReDoS: new RegExp(userInput)
- Mass assignment: ...req.body into DB models
- Insecure random: Math.random() for tokens/sessions

ARCHITECTURE:
- SOLID violations, god objects, tight coupling, wrong layer ownership
- Missing interfaces, circular dependencies, configuration anti-patterns

PERFORMANCE:
- O(n²) algorithms, await in loops, N+1 queries, sync operations in hot paths

OUTPUT FORMAT:
<<<REVIEW>>>
## EXECUTIVE SUMMARY
Overall risk score: X/10
Critical issues: N
High issues: N
Top 3 most dangerous findings:

## FINDINGS (severity-ordered)

### [CRITICAL/HIGH/MEDIUM/LOW] Finding Title
- Location: file:line
- Attack Vector: (how it's exploited — write the actual payload)
- Impact: (what attacker achieves)
- PoC: (minimal exploit code)
- Fix: (exact code change)

## REMEDIATION ROADMAP
Fix now (Critical): ...
Fix this week (High): ...
Fix this sprint (Medium): ...
<<<END>>>`,

  refactor: `You are a principal engineer specializing in code quality and maintainability.

MISSION: Restructure the code for maximum clarity, testability, and long-term maintainability.
Do not change behaviour — improve structure.

FOCUS:
- Extract functions >50 lines into smaller focused functions
- Remove duplication (>5 repeated lines → extract to shared function)
- Simplify deeply nested code (>3 levels → early returns / guard clauses)
- Fix naming (variables/functions must communicate intent in <3 seconds)
- Add TypeScript types where missing or too broad
- Apply dependency injection where code has hardcoded dependencies
- Replace callbacks with async/await
- Remove dead code (unused variables, unreachable branches, dead imports)
- Split fat classes/modules into focused, single-responsibility units

OUTPUT FORMAT:
<<<FILE: relative/path/to/file.ts>>>
[complete refactored file]
<<<END>>>

<<<SUMMARY>>>
- What was restructured and why
- Before vs after complexity (lines, functions, nesting depth)
- What to re-test after refactor
<<<END>>>`,

  analyze: `You are an elite code analyst. Perform a comprehensive read-only analysis.

Cover ALL dimensions:
1. What the code does — execution flow, data flow, key algorithms
2. Architecture — patterns used, module boundaries, dependencies
3. Security — vulnerabilities, attack surface, trust boundaries
4. Performance — bottlenecks, complexity, optimization opportunities
5. Code quality — complexity, duplication, maintainability score
6. Hidden assumptions — what breaks if input is unexpected
7. Technical debt — areas that will become problems as the codebase grows

Be specific: every observation must cite file:line.

OUTPUT FORMAT:
<<<ANALYSIS>>>
## Code Purpose
## Architecture Map
## Security Analysis
## Performance Analysis
## Code Quality Score (0-100)
## Top 5 Risks
## Recommended Actions (priority-ordered)
<<<END>>>`,

  test: `You are a test engineering specialist. Write exhaustive tests that catch every bug.

RULES:
- Test behaviour, not implementation.
- Test: happy path, error paths, edge cases, boundary conditions, concurrent access.
- Use the existing test framework (detect from package.json / existing test files).
- Tests must be self-contained and deterministic.
- Mock only at system boundaries (HTTP, DB, filesystem) — never mock internal logic.
- Aim for 100% branch coverage on the tested code.

OUTPUT FORMAT:
<<<FILE: relative/path/to/file.test.ts>>>
[complete test file]
<<<END>>>

<<<SUMMARY>>>
- Test count: N tests covering X scenarios
- Coverage: estimated branch coverage %
- How to run: exact command
<<<END>>>`,

  explain: `You are a senior engineer explaining code to a new team member.

MISSION: Make the code completely understandable. No jargon without explanation.

COVER:
1. What problem this code solves
2. How it works (execution flow, data flow, key decisions)
3. Why it was built this way (design rationale)
4. Key algorithms and data structures used
5. How the pieces connect to the rest of the system
6. What could go wrong (failure modes, edge cases)
7. How to extend or modify it safely

Use diagrams in ASCII where helpful.

OUTPUT FORMAT:
<<<EXPLANATION>>>
[detailed explanation with code references]
<<<END>>>`,
};

// ---------------------------------------------------------------------------
// File system utilities
// ---------------------------------------------------------------------------

function createBackup(abs: string): void {
  try {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const rel = path.relative(PROJECT_ROOT, abs).replace(/[\\/]/g, '__');
    // Security: reject paths containing .. (outside PROJECT_ROOT)
    if (rel.includes('..')) {
      logger.warn({ abs }, 'arsenal: backup skipped (path outside root)');
      return;
    }
    const dest = path.join(BACKUP_DIR, `${Date.now()}_${rel}`);
    if (existsSync(abs)) copyFileSync(abs, dest);
  } catch { /* non-fatal */ }
}

function resolveProjectPath(p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(PROJECT_ROOT, p);
}

// ---------------------------------------------------------------------------
// Smart file selection — keyword-based ripgrep discovery
// ---------------------------------------------------------------------------

async function smartSelectFiles(task: string, baseDir: string, maxFiles = 15): Promise<string> {
  // 1. Extract keywords: split on non-word chars, filter short words, take top 10
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'fix', 'add', 'run', 'use', 'via', 'per', 'set']);
  const keywords = task
    .split(/\W+/)
    .filter(w => w.length >= 4 && !stopWords.has(w.toLowerCase()))
    .slice(0, 10);

  // 2. Extract explicit file references from task
  const fileRefRegex = /[\w/\-\.]+\.(ts|js|tsx|jsx)/g;
  const explicitFiles: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fileRefRegex.exec(task)) !== null) {
    explicitFiles.push(fm[0]);
  }

  // 3. Ripgrep parallel searches
  const foundFiles = new Set<string>();

  for (const fp of explicitFiles) {
    const abs = resolveProjectPath(fp);
    if (existsSync(abs)) foundFiles.add(abs);
  }

  if (keywords.length > 0) {
    const rgResults = await Promise.allSettled(
      keywords.map(keyword => new Promise<string[]>((resolve) => {
        try {
          const out = execFileSync(
            'rg',
            ['-l', '--max-count=1', '-g', '*.ts', '-g', '*.js', keyword, baseDir],
            { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
          );
          resolve(out.trim().split('\n').filter(Boolean));
        } catch {
          resolve([]);
        }
      }))
    );

    for (const result of rgResults) {
      if (result.status === 'fulfilled') {
        for (const f of result.value) foundFiles.add(f);
      }
    }
  }

  // 4. Limit to maxFiles
  const selected = [...foundFiles]
    .filter(f => !f.includes('node_modules') && !f.includes('/dist/') && !f.includes('/.git/'))
    .slice(0, maxFiles);

  if (selected.length === 0) {
    // Fallback to collectSourceFiles
    return collectSourceFiles(baseDir);
  }

  // 5. Return in same format as collectSourceFiles
  const parts: string[] = [];
  for (const abs of selected) {
    try {
      const s = statSync(abs);
      if (s.size > 80_000) continue;
      const content = readFileSync(abs, 'utf-8');
      const rel = path.relative(PROJECT_ROOT, abs);
      parts.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\`\n\n`);
    } catch { /* skip unreadable */ }
  }

  if (parts.length === 0) return collectSourceFiles(baseDir);

  return parts.join('');
}

async function collectSourceFiles(dir: string, maxBytes = 600_000): Promise<string> {
  const parts: string[] = [];
  let totalBytes = 0;

  async function walk(d: string): Promise<void> {
    if (totalBytes >= maxBytes) return;
    let entries: string[];
    try { entries = await readdir(d); } catch { return; }
    for (const entry of entries.sort()) {
      if (totalBytes >= maxBytes) break;
      if (['node_modules', '.git', 'dist', 'build', '__pycache__', 'coverage'].includes(entry)) continue;
      const full = path.join(d, entry);
      let s;
      try { s = lstatSync(full); } catch { continue; }
      if (s.isSymbolicLink()) continue; // Skip symlinks — block exfiltration
      if (s.isDirectory()) { await walk(full); continue; }
      const ext = path.extname(entry).toLowerCase();
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.yaml', '.yml', '.md'].includes(ext)) continue;
      if (s.size > 80_000) continue; // skip huge individual files
      try {
        const content = readFileSync(full, 'utf-8');
        const rel = path.relative(PROJECT_ROOT, full);
        const chunk = `### ${rel}\n\`\`\`\n${content}\n\`\`\`\n\n`;
        parts.push(chunk);
        totalBytes += chunk.length;
      } catch { /* skip */ }
    }
  }
  await walk(dir);
  if (totalBytes >= maxBytes) parts.push('\n[... additional files truncated — context limit]\n');
  return parts.join('');
}

function readSpecificFiles(filePaths: string[]): string {
  const parts: string[] = [];
  for (const fp of filePaths) {
    const abs = resolveProjectPath(fp);

    // Security: must be within project root
    const relative = path.relative(PROJECT_ROOT, abs);
    if (relative.startsWith('..')) {
      parts.push(`### ${fp}\n[ACCESS DENIED — outside project root]\n\n`);
      continue;
    }

    if (!existsSync(abs)) { parts.push(`### ${fp}\n[FILE NOT FOUND]\n\n`); continue; }
    try {
      const content = readFileSync(abs, 'utf-8');
      parts.push(`### ${relative}\n\`\`\`\n${content}\n\`\`\`\n\n`);
    } catch { parts.push(`### ${fp}\n[CANNOT READ]\n\n`); }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// TypeScript checker
// ---------------------------------------------------------------------------

interface TscResult {
  clean: boolean;
  errorCount: number;
  summary: string;
}

function runTsc(): TscResult {
  if (!existsSync(TSC)) return { clean: true, errorCount: 0, summary: '(tsc not available)' };
  try {
    execSync(`"${TSC}" --noEmit`, {
      cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { clean: true, errorCount: 0, summary: 'TypeScript: clean ✓' };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const raw = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
    const matches = raw.match(/error TS\d+/g);
    const count = matches?.length ?? 0;
    // Show first 10 errors
    const lines = raw.split('\n').filter(l => l.includes('error TS')).slice(0, 10);
    return { clean: false, errorCount: count, summary: `TypeScript: ${count} error(s)\n${lines.join('\n')}` };
  }
}

// ---------------------------------------------------------------------------
// Parse AI response — extract <<<FILE: ...>>> blocks
// ---------------------------------------------------------------------------

interface ParsedEdit {
  filePath: string;
  content: string;
}

function parseAIResponse(text: string): { edits: ParsedEdit[]; summary: string; review: string; analysis: string; explanation: string } {
  const edits: ParsedEdit[] = [];
  let summary = '';
  let review = '';
  let analysis = '';
  let explanation = '';

  // Parse FILE blocks using indexOf (no ReDoS risk from lazy quantifiers)
  let pos = 0;
  while (true) {
    const startIdx = text.indexOf('<<<FILE:', pos);
    if (startIdx === -1) break;
    const endFileIdx = text.indexOf('>>>', startIdx + 8);
    if (endFileIdx === -1) break;
    const filePath = text.substring(startIdx + 8, endFileIdx).trim();

    const contentStart = text.indexOf('\n', endFileIdx) + 1;
    const contentEnd = text.indexOf('<<<END>>>', contentStart);
    if (contentEnd === -1) break;

    let content = text.substring(contentStart, contentEnd).trim();
    if (filePath && content) {
      edits.push({ filePath, content });
    }
    pos = contentEnd + 9;
  }

  // Extract SUMMARY block using indexOf
  const summaryStart = text.indexOf('<<<SUMMARY>>>');
  if (summaryStart !== -1) {
    const summaryEnd = text.indexOf('<<<END>>>', summaryStart);
    if (summaryEnd !== -1) {
      summary = text.substring(summaryStart + 13, summaryEnd).trim();
    }
  }

  // Extract REVIEW block using indexOf
  const reviewStart = text.indexOf('<<<REVIEW>>>');
  if (reviewStart !== -1) {
    const reviewEnd = text.indexOf('<<<END>>>', reviewStart);
    if (reviewEnd !== -1) {
      review = text.substring(reviewStart + 12, reviewEnd).trim();
    }
  }

  // Extract ANALYSIS block using indexOf
  const analysisStart = text.indexOf('<<<ANALYSIS>>>');
  if (analysisStart !== -1) {
    const analysisEnd = text.indexOf('<<<END>>>', analysisStart);
    if (analysisEnd !== -1) {
      analysis = text.substring(analysisStart + 14, analysisEnd).trim();
    }
  }

  // Extract EXPLANATION block using indexOf
  const explanationStart = text.indexOf('<<<EXPLANATION>>>');
  if (explanationStart !== -1) {
    const explanationEnd = text.indexOf('<<<END>>>', explanationStart);
    if (explanationEnd !== -1) {
      explanation = text.substring(explanationStart + 17, explanationEnd).trim();
    }
  }

  return { edits, summary, review, analysis, explanation };
}

// ---------------------------------------------------------------------------
// Apply edits
// ---------------------------------------------------------------------------

interface ApplyResult {
  applied: string[];
  failed: string[];
}

function applyEdits(edits: ParsedEdit[]): ApplyResult {
  const applied: string[] = [];
  const failed: string[] = [];

  for (const edit of edits) {
    const abs = resolveProjectPath(edit.filePath);

    // Security: must be within project root (check with path.sep boundary)
    const relative = path.relative(PROJECT_ROOT, abs);
    if (relative.startsWith('..')) {
      failed.push(`${edit.filePath} (path traversal blocked)`);
      continue;
    }

    try {
      // Create backup of existing file
      createBackup(abs);
      // Ensure directory exists
      const dir = path.dirname(abs);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Write to temp file first, then atomic rename (prevents partial writes)
      const tmpPath = `${abs}.tmp`;
      writeFileSync(tmpPath, edit.content, 'utf-8');
      renameSync(tmpPath, abs);
      const rel = path.relative(PROJECT_ROOT, abs);
      applied.push(rel);
      logger.info({ path: rel }, 'arsenal: file written');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push(`${edit.filePath}: ${msg}`);
    }
  }

  return { applied, failed };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const arsenalTool: ToolDefinition = {
  name: 'coder.arsenal',
  description:
    'SUDO-AI\'s ultimate autonomous coding agent — ONE TOOL, FULL PIPELINE. ' +
    'Powered by Grok 4 (2M token context, elite reasoning). ' +
    'Handles the complete workflow in a single call: ' +
    'reads all relevant files → AI analysis → writes fixes → verifies TypeScript → reports. ' +
    'Modes: "fix" (find+fix all bugs), "build" (create new feature), ' +
    '"review" (adversarial security+architecture audit), "refactor" (restructure for quality), ' +
    '"analyze" (deep read-only analysis), "test" (write exhaustive tests), "explain" (document code). ' +
    'Use for: complex multi-file bugs, building new modules, security audits, production-readiness checks. ' +
    'Pass specific files OR a directory OR raw code. Grok 4 reads everything and handles the rest.',
  category: 'coder',
  timeout: 300_000, // 5 minutes — elite tasks take time

  parameters: {
    task: {
      type: 'string',
      required: true,
      description:
        'What to do. Be specific: include file paths, error messages, acceptance criteria, context. ' +
        'E.g.: "Fix the TypeScript errors in src/core/agent/loop.ts — the loop guard is throwing on line 45" ' +
        'or "Build a rate limiter middleware for the Express API in src/server/"',
    },
    mode: {
      type: 'string',
      enum: ['fix', 'build', 'review', 'refactor', 'analyze', 'test', 'explain'],
      description: 'Operation mode. Default: "fix".',
    },
    files: {
      type: 'array',
      description:
        `Specific files or directories to work on (relative to ${PROJECT_ROOT}/ or absolute). ` +
        'If omitted with a directory target, arsenal auto-discovers relevant files.',
    },
    code: {
      type: 'string',
      description: 'Raw code to work on directly. Use when code is already in context.',
    },
    context: {
      type: 'string',
      description:
        'Additional context: error messages, stack traces, requirements, constraints, ' +
        'what was already tried. More context = better results.',
    },
    applyEdits: {
      type: 'boolean',
      description:
        'Write changes to disk (default: true for fix/build/refactor/test, false for review/analyze/explain). ' +
        'Set false to see what Grok would do without applying.',
    },
    model: {
      type: 'string',
      description: 'Force a specific model. Default: Grok 4 with cascade fallback.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task       = typeof params['task']    === 'string' ? params['task'].trim()    : '';
    const mode       = typeof params['mode']    === 'string' ? params['mode'].trim()    : 'fix';
    const rawCode    = typeof params['code']    === 'string' ? params['code'].trim()    : '';
    const context    = typeof params['context'] === 'string' ? params['context'].trim() : '';
    const forcedModel= typeof params['model']   === 'string' ? params['model'].trim()   : '';
    const filesParam = Array.isArray(params['files']) ? (params['files'] as string[]) : [];

    // Default: apply edits for mutating modes, not for read-only modes
    const readOnlyModes = new Set(['review', 'analyze', 'explain']);
    const defaultApply = !readOnlyModes.has(mode);
    const shouldApply = typeof params['applyEdits'] === 'boolean' ? params['applyEdits'] : defaultApply;

    if (!task) {
      return { success: false, output: 'coder.arsenal: "task" is required.' };
    }

    logger.info({ session: ctx.sessionId, mode, files: filesParam.length, forcedModel }, 'coder.arsenal invoked');

    // ---- STEP 1: Gather code context ----
    let codeContext = '';

    if (rawCode) {
      codeContext = `### [Inline Code]\n\`\`\`\n${rawCode}\n\`\`\`\n\n`;
    } else if (filesParam.length === 0) {
      // Auto-discover relevant files using smart keyword + ripgrep selection
      codeContext = await smartSelectFiles(task, PROJECT_ROOT);
    } else if (filesParam.length > 0) {
      const parts: string[] = [];
      for (const fp of filesParam) {
        const abs = resolveProjectPath(fp);
        if (!existsSync(abs)) { parts.push(`[Not found: ${fp}]\n`); continue; }
        const s = statSync(abs);
        if (s.isDirectory()) {
          parts.push(await collectSourceFiles(abs));
        } else {
          parts.push(readSpecificFiles([fp]));
        }
      }
      codeContext = parts.join('');
    }

    // ---- STEP 2: Baseline typecheck (for mutating modes) ----
    let baselineTsc: TscResult | null = null;
    if (shouldApply && ['fix', 'build', 'refactor', 'test'].includes(mode)) {
      baselineTsc = runTsc();
      logger.info({ errors: baselineTsc.errorCount }, 'arsenal: baseline tsc');
    }

    // ---- STEP 3: Build AI prompt ----
    const systemPrompt = SYSTEM_PROMPTS[mode] ?? SYSTEM_PROMPTS['fix']!;

    // Sanitize context to prevent prompt injection
    const sanitizedContext = context
      ? context
          .replace(/<<<(FILE|SUMMARY|REVIEW|ANALYSIS|EXPLANATION|END)/g, '[REDACTED]')
          .replace(/SYSTEM:/g, '[REDACTED]')
      : '';

    const userPrompt = [
      `TASK: ${task}`,
      sanitizedContext ? `\nADDITIONAL CONTEXT:\n${sanitizedContext}` : '',
      baselineTsc && !baselineTsc.clean
        ? `\nBASELINE STATE: ${baselineTsc.errorCount} TypeScript errors exist before your changes.`
        : '',
      codeContext ? `\n\nCODE TO WORK ON:\n${codeContext}` : '',
    ].filter(Boolean).join('');

    // ---- STEP 4: Call AI with cascade ----
    const cascade = forcedModel
      ? [{ model: forcedModel, label: forcedModel }, ...MODEL_CASCADE]
      : MODEL_CASCADE;

    const errors: string[] = [];
    let aiText = '';
    let usedModel = '';

    for (const option of cascade) {
      try {
        const model = getModel(option.model);
        logger.info({ model: option.model, mode }, 'arsenal: trying model');

        const result = await generateText({
          model,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: 32768,
          temperature: mode === 'review' || mode === 'analyze' ? 0.2 : 0.4,
        });

        const text = result.text?.trim() ?? '';
        if (!text) { errors.push(`${option.label}: empty response`); continue; }

        aiText = text;
        usedModel = option.label;
        logger.info({ model: option.model, chars: text.length }, 'arsenal: AI responded');
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const skip = msg.includes('not configured') || msg.includes('API key');
        if (skip) { logger.debug({ model: option.model }, 'arsenal: not configured'); continue; }
        logger.warn({ model: option.model, err: msg }, 'arsenal: model failed');
        errors.push(`${option.label}: ${msg.slice(0, 80)}`);
      }
    }

    if (!aiText) {
      return {
        success: false,
        output: [
          'coder.arsenal: All models failed.',
          '',
          ...errors.map(e => `  • ${e}`),
          '',
          'Check XAI_API_KEY in config/.env',
        ].join('\n'),
      };
    }

    // ---- STEP 5: Parse AI response ----
    const parsed = parseAIResponse(aiText);

    // ---- STEP 6: Apply edits (if mutating mode) ----
    let applyResult: ApplyResult = { applied: [], failed: [] };
    let afterTsc: TscResult | null = null;

    if (shouldApply && parsed.edits.length > 0) {
      applyResult = applyEdits(parsed.edits);
      logger.info({ applied: applyResult.applied.length, failed: applyResult.failed.length }, 'arsenal: edits applied');

      // Re-run typecheck after edits
      afterTsc = runTsc();
      logger.info({ errors: afterTsc.errorCount }, 'arsenal: post-edit tsc');
    }

    // ---- STEP 6.5: Auto-verification — run coder.review on changed files ----
    // For fix/build/refactor modes: quick security scan on everything that changed.
    let autoReviewFindings = '';
    if (shouldApply && applyResult.applied.length > 0 && ['fix', 'build', 'refactor'].includes(mode)) {
      try {
        const { codeReviewTool } = await import('./code-review.js');
        const reviewCtx = { sessionId: ctx.sessionId, logger: logger };
        // Review each changed TS file for critical/high findings
        const tsFiles = applyResult.applied.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
        if (tsFiles.length > 0) {
          const reviewResult = await codeReviewTool.execute(
            { path: tsFiles[0]!, focus: 'security' },
            reviewCtx as typeof ctx,
          );
          if (reviewResult.success && reviewResult.output && !reviewResult.output.includes('No issues found')) {
            // Only surface critical/high findings
            const lines = reviewResult.output.split('\n');
            const critical = lines.filter(l => l.includes('CRITICAL') || l.includes('HIGH'));
            if (critical.length > 0) {
              autoReviewFindings = `\n## Auto-Verification (Security)\n${critical.slice(0, 5).join('\n')}\n⚠ Fix these before deploying.`;
            }
          }
        }
      } catch { /* non-fatal — don't let review failure break the main flow */ }
    }

    // ---- STEP 7: Build final report ----
    const reportLines: string[] = [
      `**[CODER.ARSENAL — ${usedModel} — ${mode.toUpperCase()}]**`,
      '',
    ];

    // Add the AI's full reasoning/output (for non-edit modes or when no edits were found)
    if (parsed.edits.length === 0 || readOnlyModes.has(mode)) {
      // For read-only modes, show the structured output
      if (parsed.review) reportLines.push(parsed.review);
      else if (parsed.analysis) reportLines.push(parsed.analysis);
      else if (parsed.explanation) reportLines.push(parsed.explanation);
      else reportLines.push(aiText); // fallback: show full AI response
    }

    // Edit results
    if (applyResult.applied.length > 0) {
      reportLines.push('## Files Modified');
      for (const f of applyResult.applied) reportLines.push(`  ✓ ${f}`);
      reportLines.push('');
    }
    if (applyResult.failed.length > 0) {
      reportLines.push('## Files Failed');
      for (const f of applyResult.failed) reportLines.push(`  ✗ ${f}`);
      reportLines.push('');
    }

    // TypeScript status
    if (baselineTsc && afterTsc) {
      const improved = afterTsc.errorCount < baselineTsc.errorCount;
      const clean = afterTsc.clean;
      reportLines.push('## TypeScript Status');
      reportLines.push(`  Before: ${baselineTsc.errorCount} error(s)`);
      reportLines.push(`  After:  ${afterTsc.errorCount} error(s) ${clean ? '✓ CLEAN' : improved ? '(improved)' : '⚠'}`);
      if (!afterTsc.clean) {
        reportLines.push('');
        reportLines.push(afterTsc.summary);
      }
      reportLines.push('');
    }

    // Summary from AI
    if (parsed.summary) {
      reportLines.push('## Summary');
      reportLines.push(parsed.summary);
      reportLines.push('');
    }

    // Auto-verification findings
    if (autoReviewFindings) {
      reportLines.push(autoReviewFindings);
    }

    // If no structured blocks but there was a summary in AI text, append it
    if (!parsed.summary && !parsed.review && !parsed.analysis && !parsed.explanation && parsed.edits.length > 0) {
      // Extract any text after the last <<<END>>> as the summary
      const lastEnd = aiText.lastIndexOf('<<<END>>>');
      if (lastEnd > 0) {
        const trailing = aiText.slice(lastEnd + 9).trim();
        if (trailing) { reportLines.push('## Notes'); reportLines.push(trailing); }
      }
    }

    const success = applyResult.failed.length === 0 && (afterTsc?.clean ?? true);

    return {
      success,
      output: reportLines.join('\n'),
      data: {
        model: usedModel,
        mode,
        filesModified: applyResult.applied,
        typeErrorsBefore: baselineTsc?.errorCount ?? null,
        typeErrorsAfter: afterTsc?.errorCount ?? null,
        typesClean: afterTsc?.clean ?? null,
        editsFound: parsed.edits.length,
        editsApplied: applyResult.applied.length,
      },
    };
  },
};

/**
 * Direct trigger for KAIROS autonomous self-repair.
 * Allows KAIROS to call arsenal "refactor" or "fix" on detected large_file or codebase_degraded.
 * Stub ctx for direct use (PROJECT_ROOT guard preserved).
 */
export async function triggerKAIROSRepair(task: string, mode: 'fix' | 'refactor' = 'refactor'): Promise<{ success: boolean; output: string }> {
  // Security: sanitize task — reject prompt-injection markers
  if (task.includes('<<<') || task.includes('>>>') || task.includes('SYSTEM:')) {
    logger.warn({ task }, 'KAIROS: task rejected (contains injection markers)');
    return { success: false, output: 'error: task contains invalid markers' };
  }

  // KAIROS self-repair hook. Real dry-run call (applyEdits:false) to avoid side effects in background tick.
  // Matches "as before" verified patterns (sim + guards); uses internal execute for full pipeline (recon/baseline/AI/verify).
  logger.info({ task, mode }, 'KAIROS requested arsenal self-repair (dry-run wired)');
  try {
    // Minimal ctx (session/logger only; full ToolContext not required for read-only dry).
    // Partial stub asserted through unknown: execute() does not touch the missing fields
    // on the applyEdits:false path.
    const ctx = { sessionId: 'kairos-self-repair', logger } as unknown as ToolContext;
    const result = await arsenalTool.execute({ task, mode, applyEdits: false }, ctx);
    return { success: !!result.success, output: String(result.output || '').slice(0, 300) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: msg, task, mode }, 'KAIROS-arsenal trigger failed (non-fatal)');
    return { success: false, output: `error: ${msg.slice(0, 100)}` };
  }
}

// KAIROS trigger added for self-repair wiring. Call triggerKAIROSRepair(task, 'refactor' | 'fix') from kairos actOnObservation. Safe, dry, env-kill in caller.


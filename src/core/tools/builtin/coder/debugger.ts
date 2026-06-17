/**
 * coder.debug — Parse error/stack traces, locate source, and suggest fixes.
 * Optionally applies a patch via the edit-file logic when autoFix is enabled.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { resolveSandboxOrHostPath } from './sandbox-path.js';

// ---------------------------------------------------------------------------
// Stack trace parsing
// ---------------------------------------------------------------------------

interface StackFrame {
  functionName: string;
  file: string;
  line: number;
  column: number;
}

/** Parse Node.js, Deno, and browser-style stack traces. */
function parseStackTrace(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = stack.split('\n');

  for (const line of lines) {
    // Node.js: "    at functionName (file:line:col)"
    const nodeMatch = line.match(/^\s+at\s+(?:(.+?)\s+)?\(?((?:file:\/\/)?\/[^):\s]+):(\d+):(\d+)\)?/);
    if (nodeMatch) {
      frames.push({
        functionName: nodeMatch[1]?.trim() ?? '<anonymous>',
        file: nodeMatch[2]?.replace(/^file:\/\//, '') ?? '',
        line: parseInt(nodeMatch[3] ?? '0', 10),
        column: parseInt(nodeMatch[4] ?? '0', 10),
      });
      continue;
    }

    // Deno/V8: "    at file:///path/to/file.ts:10:5"
    const denoMatch = line.match(/^\s+at\s+(file:\/\/\/[^:]+):(\d+):(\d+)/);
    if (denoMatch) {
      frames.push({
        functionName: '<anonymous>',
        file: denoMatch[1]?.replace(/^file:\/\//, '') ?? '',
        line: parseInt(denoMatch[2] ?? '0', 10),
        column: parseInt(denoMatch[3] ?? '0', 10),
      });
    }
  }

  return frames;
}

/** Extract the first app-code frame (non-node_modules, non-internal). */
function findRootCauseFrame(frames: StackFrame[], cwd: string): StackFrame | undefined {
  return frames.find(
    (f) => f.file && !f.file.includes('node_modules') && !f.file.startsWith('node:') && f.file.startsWith('/'),
  ) ?? frames.find((f) => f.file && f.file.startsWith(cwd));
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

interface ErrorClassification {
  type: string;
  description: string;
  likelyCause: string;
  suggestedFix: string;
}

function classifyError(errorMessage: string): ErrorClassification {
  const checks: Array<[RegExp, ErrorClassification]> = [
    [/TypeError.*is not a function/i, { type: 'TypeError', description: 'Calling something that is not a function.',
      likelyCause: 'Variable is undefined, null, or the wrong type.', suggestedFix: 'Add a null/type check before the call.' }],
    [/TypeError.*Cannot read propert/i, { type: 'TypeError', description: 'Accessing a property on null or undefined.',
      likelyCause: 'Async data not yet loaded, or optional chaining missing.', suggestedFix: 'Use optional chaining (?.) and add null guards.' }],
    [/ReferenceError.*is not defined/i, { type: 'ReferenceError', description: 'Variable used before declaration.',
      likelyCause: 'Typo in variable name, missing import, or scope issue.', suggestedFix: 'Check imports and variable names.' }],
    [/SyntaxError/i, { type: 'SyntaxError', description: 'Invalid JavaScript/TypeScript syntax.',
      likelyCause: 'Missing bracket, comma, or malformed expression.', suggestedFix: 'Check the file at the reported line for syntax errors.' }],
    [/ENOENT.*no such file/i, { type: 'ENOENT', description: 'File or directory not found.',
      likelyCause: 'Wrong path, missing file, or cwd mismatch.', suggestedFix: 'Verify the path exists and check workingDir.' }],
    [/EACCES|EPERM/i, { type: 'PermissionError', description: 'File system permission denied.',
      likelyCause: 'Insufficient OS permissions for the target path.', suggestedFix: 'Check file permissions (chmod) or run with elevated rights.' }],
    [/ECONNREFUSED/i, { type: 'ConnectionError', description: 'Network connection refused.',
      likelyCause: 'Target service not running or wrong host/port.', suggestedFix: 'Verify the service is running and the connection config is correct.' }],
    [/MODULE_NOT_FOUND|Cannot find module/i, { type: 'ModuleNotFound', description: 'Node module resolution failed.',
      likelyCause: 'Package not installed or import path incorrect.', suggestedFix: 'Run pnpm install and check the import path (including .js extension for ESM).' }],
    [/Maximum call stack|stack overflow/i, { type: 'StackOverflow', description: 'Infinite recursion detected.',
      likelyCause: 'A function calls itself without a base case.', suggestedFix: 'Add a termination condition to the recursive function.' }],
    [/out of memory|heap/i, { type: 'OOM', description: 'Out of memory.',
      likelyCause: 'Processing too much data at once or a memory leak.',
      suggestedFix: 'Stream data instead of loading into memory. Check for unreleased references.' }],
  ];

  for (const [pattern, result] of checks) {
    if (pattern.test(errorMessage)) return result;
  }

  return { type: 'UnknownError', description: errorMessage.split('\n')[0] ?? errorMessage,
    likelyCause: 'Unknown — see stack trace for clues.', suggestedFix: 'Inspect the root cause frame and surrounding code.' };
}

// ---------------------------------------------------------------------------
// Auto-fix heuristics
// ---------------------------------------------------------------------------

interface AutoFix {
  applied: boolean;
  description: string;
  oldText?: string;
  newText?: string;
}

function buildAutoFix(errorType: string, code: string, line: string): AutoFix | null {
  if (errorType === 'TypeError' && /Cannot read propert/i.test(errorType + code)) {
    // Add optional chaining where property access exists
    const fixed = line.replace(/(\w+)\.(\w+)/g, '$1?.$2');
    if (fixed !== line) {
      return { applied: false, description: 'Add optional chaining (?.) to property access', oldText: line, newText: fixed };
    }
  }
  return null;
}

async function applyAutoFix(filePath: string, lineNum: number, fix: AutoFix): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const targetLine = lines[lineNum - 1];
    if (!targetLine || !fix.oldText || !fix.newText) return false;
    if (targetLine.trim() !== fix.oldText.trim()) return false;
    lines[lineNum - 1] = targetLine.replace(fix.oldText.trim(), fix.newText.trim());
    await writeFile(filePath, lines.join('\n'), 'utf-8');
    fix.applied = true;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const debuggerTool: ToolDefinition = {
  name: 'coder.debug',
  description:
    'FIRST TOOL to call when any error occurs. Parse error + stack trace → classify error type → ' +
    'locate root cause frame → read source at that line → suggest precise fix. ' +
    'Protocol: pass the FULL error message and complete stack trace. Then read the located file. ' +
    'Then grep for the erroring symbol to find all callers. Then apply fix with coder.smart-edit. ' +
    'Use custom.codex if root cause is still unclear after reading the source. ' +
    'autoFix=true applies heuristic patches directly — use for common errors (undefined, null access, missing import).',
  category: 'coder',
  timeout: 30_000,
  parameters: {
    error: {
      type: 'string',
      required: true,
      description: 'The error message string.',
    },
    stackTrace: {
      type: 'string',
      required: false,
      description: 'Full stack trace text. If omitted, only error classification is performed.',
    },
    cwd: {
      type: 'string',
      required: false,
      description: 'Working directory to resolve relative paths. Defaults to session cwd.',
    },
    autoFix: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'When true, attempt to apply a heuristic fix to the source file.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const errorMsg = params['error'];
    if (typeof errorMsg !== 'string' || errorMsg.trim() === '') {
      return { success: false, output: 'coder.debug: "error" parameter is required.' };
    }

    const stackTrace = typeof params['stackTrace'] === 'string' ? params['stackTrace'] : '';
    const debugCwd = typeof params['cwd'] === 'string'
      ? await resolveSandboxOrHostPath(ctx.workingDir, params['cwd'])
      : ctx.workingDir;
    const autoFix = params['autoFix'] === true;

    // Step 1: Classify error
    const classification = classifyError(errorMsg);

    // Step 2: Parse stack trace
    const fullText = stackTrace || errorMsg;
    const frames = parseStackTrace(fullText);
    const rootFrame = findRootCauseFrame(frames, debugCwd);

    // Step 3: Read source around root frame
    let surroundingCode = '';
    let fixResult: AutoFix | null = null;

    if (rootFrame && rootFrame.file) {
      try {
        const content = await readFile(rootFrame.file, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(0, rootFrame.line - 4);
        const end = Math.min(lines.length, rootFrame.line + 3);
        const numbered = lines.slice(start, end).map((l, i) => {
          const ln = start + i + 1;
          const marker = ln === rootFrame.line ? '>>>' : '   ';
          return `${marker} ${String(ln).padStart(4)} | ${l}`;
        });
        surroundingCode = numbered.join('\n');

        // Auto-fix attempt
        if (autoFix) {
          const targetLine = lines[rootFrame.line - 1] ?? '';
          fixResult = buildAutoFix(classification.type, errorMsg, targetLine);
          if (fixResult) {
            await applyAutoFix(rootFrame.file, rootFrame.line, fixResult);
          }
        }
      } catch {
        surroundingCode = '(could not read source file)';
      }
    }

    log.info({ tool: 'coder.debug', errorType: classification.type, framesFound: frames.length }, 'Debug analysis complete');

    const sections: string[] = [
      `Error Type: ${classification.type}`,
      `Description: ${classification.description}`,
      `Likely Cause: ${classification.likelyCause}`,
      `Suggested Fix: ${classification.suggestedFix}`,
    ];

    if (rootFrame) {
      sections.push(`\nRoot Cause Location: ${rootFrame.file}:${rootFrame.line}:${rootFrame.column} (in ${rootFrame.functionName})`);
    }

    if (surroundingCode) {
      sections.push(`\nSource Code Context:\n${surroundingCode}`);
    }

    if (frames.length > 0) {
      sections.push(`\nStack Frames (${frames.length}):`);
      frames.slice(0, 8).forEach((f, i) => {
        sections.push(`  ${i + 1}. ${f.functionName} — ${f.file}:${f.line}`);
      });
    }

    if (fixResult) {
      sections.push(
        `\nAuto-Fix: ${fixResult.applied ? 'APPLIED' : 'NOT APPLIED (confidence too low)'}`,
        fixResult.applied ? `Description: ${fixResult.description}` : '',
      );
    }

    return {
      success: true,
      output: sections.filter(Boolean).join('\n'),
      data: { classification, rootFrame, frames, fixApplied: fixResult?.applied ?? false },
      artifacts: (fixResult?.applied && rootFrame)
        ? [{ path: rootFrame.file, action: 'modified' as const }]
        : undefined,
    };
  },
};

export default debuggerTool;

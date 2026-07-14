/**
 * textproc.extract — precise, memory-bounded extraction from huge files
 * (Spec 10 §5.3). Never reads the whole file: line ranges use sed's early
 * exit (`A,Bp;Bq`), byte ranges use tail -c/head -c, so a 100 GB file costs
 * only the bytes up to the range end. Composes via execFile arg-arrays; the
 * one pipe (bytes+fields) uses a fixed bash template with positional args.
 */

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { clampHeadTail } from '../../../shared/head-tail-buffer.js';
import { runArgv, runBashTemplate } from './proc.js';

const MAX_OUTPUT_CHARS = 8_000;
const RANGE_RE = /^(\d+)-(\d+)$/;
const COLS_RE = /^[0-9,-]+$/;

function resolveFile(file: string, ctx: ToolContext): string {
  return isAbsolute(file) ? file : resolve(ctx.workingDir, file);
}

function fail(message: string): ToolResult {
  return { success: false, output: message };
}

export const extractTool: ToolDefinition = {
  name: 'textproc.extract',
  description:
    'Extract a precise slice of a file WITHOUT loading it into memory — built for multi-GB logs. ' +
    'Give exactly one of: lines "START-END" (1-based, inclusive), bytes "START-END" (0-based offset), ' +
    'head N, or tail N. Optionally project delimited fields with fields {sep, cols} (cut syntax, ' +
    'e.g. cols "1,3-5"). Streams with early exit (sed q / head -c), so line 20,000,000 of a 100 GB ' +
    'file is cheap. Output capped at 8000 chars with an honest truncation note.',
  category: 'textproc',
  parameters: {
    file: { type: 'string', description: 'Path to the file (absolute or relative to the working dir).', required: true },
    lines: { type: 'string', description: 'Line range "START-END", 1-based inclusive (e.g. "100-150").' },
    bytes: { type: 'string', description: 'Byte range "START-END", 0-based, end exclusive.' },
    head: { type: 'number', description: 'First N lines.' },
    tail: { type: 'number', description: 'Last N lines.' },
    fields: {
      type: 'object',
      description: 'Optional field projection: { sep: single delimiter char, cols: cut -f spec like "1,3-5" }. Not combinable with bytes.',
      properties: {
        sep: { type: 'string', description: 'Single-character field delimiter (default TAB).' },
        cols: { type: 'string', description: 'cut -f column spec, digits/commas/dashes only.' },
      },
    },
    maxOutput: { type: 'number', description: 'Output character cap (default 8000, max 32000).' },
  },
  safety: 'readonly',
  timeout: 90_000,
  async execute(params, ctx): Promise<ToolResult> {
    const file = resolveFile(String(params['file'] ?? ''), ctx);
    let st;
    try {
      st = statSync(file);
    } catch {
      return fail(`textproc.extract: file not found: ${file}`);
    }
    if (!st.isFile()) return fail(`textproc.extract: not a regular file: ${file}`);

    const selectors = ['lines', 'bytes', 'head', 'tail'].filter((k) => params[k] !== undefined && params[k] !== null);
    if (selectors.length !== 1) {
      return fail(`textproc.extract: give exactly ONE of lines/bytes/head/tail (got: ${selectors.join(', ') || 'none'})`);
    }

    const maxOutput = Math.min(Math.max(Number(params['maxOutput']) || MAX_OUTPUT_CHARS, 200), 32_000);
    // Collect up to 4× the character budget in bytes, then clamp — bounded RSS.
    const maxBytes = maxOutput * 4;

    const fieldsParam = params['fields'] as { sep?: string; cols?: string } | undefined;
    let cutArgs: string[] | null = null;
    if (fieldsParam?.cols !== undefined) {
      const cols = String(fieldsParam.cols);
      if (!COLS_RE.test(cols)) return fail(`textproc.extract: fields.cols must match ${COLS_RE} (got "${cols}")`);
      const sep = fieldsParam.sep !== undefined ? String(fieldsParam.sep) : '\t';
      if (sep.length !== 1) return fail('textproc.extract: fields.sep must be a single character');
      cutArgs = ['-d', sep, '-f', cols];
    }

    let result;
    const selector = selectors[0]!;
    if (selector === 'lines') {
      const m = RANGE_RE.exec(String(params['lines']));
      if (!m) return fail('textproc.extract: lines must be "START-END" (e.g. "100-150")');
      const [a, b] = [parseInt(m[1]!, 10), parseInt(m[2]!, 10)];
      if (a < 1 || b < a) return fail(`textproc.extract: bad line range ${a}-${b} (need 1 <= START <= END)`);
      // a,b are validated integers — the sed expression contains no user text.
      const sedExpr = `${a},${b}p;${b}q`;
      result = cutArgs
        ? await runBashTemplate('sed -n -- "$1" "$2" | cut -d "$3" -f "$4"', [sedExpr, file, cutArgs[1]!, cutArgs[3]!], { maxBytes })
        : await runArgv('sed', ['-n', sedExpr, '--', file], { maxBytes });
    } else if (selector === 'bytes') {
      const m = RANGE_RE.exec(String(params['bytes']));
      if (!m) return fail('textproc.extract: bytes must be "START-END" (0-based, end exclusive)');
      const [a, b] = [parseInt(m[1]!, 10), parseInt(m[2]!, 10)];
      if (b <= a) return fail(`textproc.extract: bad byte range ${a}-${b}`);
      if (cutArgs) return fail('textproc.extract: fields is not combinable with bytes');
      result = await runBashTemplate(
        'tail -c "+$1" -- "$3" | head -c "$2"',
        [String(a + 1), String(b - a), file],
        { maxBytes },
      );
    } else {
      const n = Math.floor(Number(params[selector]));
      if (!Number.isFinite(n) || n < 1) return fail(`textproc.extract: ${selector} must be a positive number`);
      const base: [string, string[]] = selector === 'head' ? ['head', ['-n', String(n), '--', file]] : ['tail', ['-n', String(n), '--', file]];
      result = cutArgs
        ? await runBashTemplate(`${base[0]} -n "$1" -- "$2" | cut -d "$3" -f "$4"`, [String(n), file, cutArgs[1]!, cutArgs[3]!], { maxBytes })
        : await runArgv(base[0], base[1], { maxBytes });
    }

    if (result.code !== 0 && !result.stdout) {
      return fail(`textproc.extract failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
    }
    const { text, truncated } = clampHeadTail(result.stdout, {
      headBudget: Math.floor(maxOutput / 2),
      tailBudget: Math.ceil(maxOutput / 2),
      elisionMarker: '...[truncated — {n} chars elided]...',
    });
    const notes: string[] = [];
    if (truncated || result.truncated) notes.push(`output truncated to ~${maxOutput} chars (narrow the range for more)`);
    return {
      success: true,
      output: text + (notes.length ? `\n[textproc.extract: ${notes.join('; ')}]` : ''),
      data: { file, selector, fileSize: st.size, truncated: truncated || result.truncated },
    };
  },
};

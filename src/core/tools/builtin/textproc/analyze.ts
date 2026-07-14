/**
 * textproc.analyze — lightweight streaming aggregation over delimited/JSONL
 * data (Spec 10 §5.3). Routes through the capability resolution: Miller (mlr)
 * when installed, else the pure-python csv fallback — and reports which one
 * ran (`via`) so results are never silently produced by a weaker engine.
 */

import { statSync } from 'node:fs';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { clampHeadTail } from '../../../shared/head-tail-buffer.js';
import { getManifest } from './capabilities.js';
import { runArgv } from './proc.js';

const FALLBACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fallbacks');
const MAX_OUTPUT_CHARS = 8_000;
const AGGS = new Set(['mean', 'sum', 'min', 'max', 'count', 'median']);
const FIELD_RE = /^[\w .@-]+$/;

function fail(message: string): ToolResult {
  return { success: false, output: message };
}

export const analyzeTool: ToolDefinition = {
  name: 'textproc.analyze',
  description:
    'Streaming stats/aggregation over CSV, TSV, or JSONL files without loading them whole: ' +
    'op:"stats" (count/sum/mean/median/min/max of column), op:"groupby" (aggregate column per key, ' +
    'agg defaults to mean), op:"freq" (value frequency table of column). Uses Miller (mlr) when ' +
    'installed, else a pure-python fallback — the result names which engine ran. For anything ' +
    'fancier, compose mlr/qsv/datamash directly via system.exec (see textproc.capabilities).',
  category: 'textproc',
  parameters: {
    file: { type: 'string', description: 'Path to the data file.', required: true },
    format: { type: 'string', description: 'Input format (default: by extension, falling back to csv).', enum: ['csv', 'tsv', 'jsonl'] },
    op: { type: 'string', description: 'What to compute.', enum: ['stats', 'groupby', 'freq'], required: true },
    column: { type: 'string', description: 'Value column (stats/groupby: numeric; freq: any).', required: true },
    key: { type: 'string', description: 'Grouping column (required for groupby).' },
    agg: { type: 'string', description: 'groupby aggregation (default mean).', enum: ['mean', 'sum', 'min', 'max', 'count', 'median'] },
  },
  safety: 'readonly',
  timeout: 120_000,
  async execute(params, ctx): Promise<ToolResult> {
    const fileParam = String(params['file'] ?? '');
    const file = isAbsolute(fileParam) ? fileParam : resolve(ctx.workingDir, fileParam);
    try {
      if (!statSync(file).isFile()) return fail(`textproc.analyze: not a regular file: ${file}`);
    } catch {
      return fail(`textproc.analyze: file not found: ${file}`);
    }
    const op = String(params['op'] ?? '');
    const column = String(params['column'] ?? '');
    const key = params['key'] !== undefined ? String(params['key']) : undefined;
    const agg = params['agg'] !== undefined ? String(params['agg']) : 'mean';
    if (!['stats', 'groupby', 'freq'].includes(op)) return fail(`textproc.analyze: unknown op "${op}"`);
    if (!FIELD_RE.test(column)) return fail(`textproc.analyze: suspicious column name "${column}"`);
    if (key !== undefined && !FIELD_RE.test(key)) return fail(`textproc.analyze: suspicious key name "${key}"`);
    if (op === 'groupby' && !key) return fail('textproc.analyze: groupby needs key');
    if (!AGGS.has(agg)) return fail(`textproc.analyze: unknown agg "${agg}"`);

    const format = typeof params['format'] === 'string' && params['format']
      ? String(params['format'])
      : file.endsWith('.tsv') ? 'tsv' : file.endsWith('.jsonl') || file.endsWith('.ndjson') ? 'jsonl' : 'csv';

    const manifest = await getManifest();
    const mlrPath = manifest.tools['mlr']?.path;

    let result;
    let via: string;
    if (mlrPath) {
      via = 'mlr (native)';
      const input = format === 'tsv' ? '--itsv' : format === 'jsonl' ? '--ijsonl' : '--icsv';
      const verb =
        op === 'stats' ? ['stats1', '-a', 'count,sum,mean,median,min,max', '-f', column]
        : op === 'groupby' ? ['stats1', '-a', agg, '-f', column, '-g', key!]
        : ['count-distinct', '-f', column];
      result = await runArgv(mlrPath, [input, '--ojson', ...verb, file], { maxBytes: 512 * 1024 });
    } else {
      if (format === 'jsonl') {
        return fail(
          'textproc.analyze: JSONL needs Miller (mlr), which is not installed on this backend — ' +
          'operator can run scripts/provision-textproc.sh, or convert with jq -r first.',
        );
      }
      const py = manifest.tools['python3']?.path;
      if (!py) return fail('textproc.analyze: neither mlr nor python3 available on this backend');
      via = 'python fallback (csv_fallback.py)';
      if (format === 'tsv') {
        return fail('textproc.analyze: the python fallback handles csv only — convert TSV first (tr "\\t" ,) or install mlr');
      }
      const script = join(FALLBACKS_DIR, 'csv_fallback.py');
      const argv =
        op === 'stats' ? [script, 'stats', '--col', column]
        : op === 'groupby' ? [script, 'groupby', '--key', key!, '--col', column, '--op', agg]
        : [script, 'freq', '--col', column];
      result = await runArgv(py, argv, { stdinFile: file, maxBytes: 512 * 1024 });
    }

    if (result.code !== 0 && !result.stdout) {
      return fail(`textproc.analyze failed via ${via} (exit ${result.code}): ${result.stderr.slice(0, 500)}`);
    }
    const { text, truncated } = clampHeadTail(result.stdout, {
      headBudget: MAX_OUTPUT_CHARS / 2,
      tailBudget: MAX_OUTPUT_CHARS / 2,
      elisionMarker: '...[truncated — {n} chars elided]...',
    });
    const note = truncated || result.truncated ? '\n[textproc.analyze: output truncated]' : '';
    return {
      success: true,
      output: `via ${via}\n${text}${note}`,
      data: { via, op, format, truncated: truncated || result.truncated },
    };
  },
};

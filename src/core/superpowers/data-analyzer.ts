/** super.analyze-data — Analyze CSV/JSON data files with stats and natural language queries. */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types.js';

const logger = createLogger('super.analyze-data');

type Row = Record<string, string | number | null>;

interface ColumnStats {
  column: string;
  type: 'numeric' | 'string';
  count: number;
  nulls: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  unique?: number;
}

/**
 * Tokenize CSV text into rows of raw string fields, honoring RFC-4180 quoting:
 * quoted fields may contain commas, newlines, and escaped quotes ("").
 * Unquoted fields are trimmed of surrounding whitespace to match prior behavior.
 */
function parseCSVRecords(rawContent: string): string[][] {
  // Trim surrounding whitespace/blank lines (outside any field) to match the
  // prior behavior of `content.trim()` before line splitting.
  const content = rawContent.trim();
  const records: string[][] = [];
  let field = '';
  let fieldQuoted = false;
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = content.length;

  const pushField = () => {
    row.push(fieldQuoted ? field : field.trim());
    field = '';
    fieldQuoted = false;
  };
  const pushRow = () => {
    pushField();
    records.push(row);
    row = [];
  };

  while (i < n) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      fieldQuoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      // Handle CRLF and bare CR as a single line terminator.
      pushRow();
      if (content[i + 1] === '\n') i++;
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush the trailing field/row unless the content ended with a terminator
  // that already produced an empty trailing record.
  if (field !== '' || fieldQuoted || row.length > 0) {
    pushRow();
  }
  return records;
}

function parseCSV(content: string): Row[] {
  const records = parseCSVRecords(content);
  if (records.length === 0) return [];
  const headers = records[0] ?? [];
  return records.slice(1).map((values) => {
    const row: Row = {};
    headers.forEach((h, i) => {
      const v = values[i] ?? '';
      const num = Number(v);
      row[h] = v === '' ? null : isNaN(num) ? v : num;
    });
    return row;
  });
}

function parseJSON(content: string): Row[] {
  const parsed = JSON.parse(content) as unknown;
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr as Row[];
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function computeStats(rows: Row[]): ColumnStats[] {
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0] ?? {});

  return columns.map((col) => {
    const values = rows.map((r) => r[col]);
    const nulls = values.filter((v) => v === null || v === undefined).length;
    const numerics = values.filter((v): v is number => typeof v === 'number');

    if (numerics.length > values.length / 2) {
      const sorted = [...numerics].sort((a, b) => a - b);
      const sum = sorted.reduce((s, v) => s + v, 0);
      return {
        column: col,
        type: 'numeric',
        count: values.length,
        nulls,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: parseFloat((sum / sorted.length).toFixed(4)),
        median: median(sorted),
      };
    }

    const uniqueVals = new Set(values.filter((v) => v !== null).map(String));
    return { column: col, type: 'string', count: values.length, nulls, unique: uniqueVals.size };
  });
}

function applyQuestion(rows: Row[], question: string): { rows: Row[]; note: string } {
  const q = question.toLowerCase();
  let result = [...rows];
  const notes: string[] = [];

  const sortMatch = q.match(/sort(?:ed)? by (\w+)(?: (asc|desc))?/);
  if (sortMatch) {
    const col = sortMatch[1] ?? '';
    const dir = sortMatch[2] === 'desc' ? -1 : 1;
    result.sort((a, b) => {
      const av = a[col] ?? '';
      const bv = b[col] ?? '';
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
    notes.push(`Sorted by "${col}" ${dir === 1 ? 'asc' : 'desc'}`);
  }

  const filterMatch = q.match(/where (\w+)\s*(=|>|<|>=|<=|!=)\s*([^\s]+)/);
  if (filterMatch) {
    const [, col, op, val] = filterMatch;
    const num = Number(val);
    result = result.filter((row) => {
      const rv = row[col ?? ''];
      const cv = typeof rv === 'number' ? rv : String(rv);
      const fv = isNaN(num) ? val : num;
      switch (op) {
        case '=': return cv === fv;
        case '!=': return cv !== fv;
        case '>': return (cv as number) > (fv as number);
        case '<': return (cv as number) < (fv as number);
        case '>=': return (cv as number) >= (fv as number);
        case '<=': return (cv as number) <= (fv as number);
        default: return true;
      }
    });
    notes.push(`Filtered where "${col}" ${op} "${val}" → ${result.length} rows`);
  }

  const limitMatch = q.match(/(?:top|first|limit)\s+(\d+)/);
  if (limitMatch) {
    const n = parseInt(limitMatch[1] ?? '10', 10);
    result = result.slice(0, n);
    notes.push(`Limited to ${n} rows`);
  }

  return { rows: result, note: notes.join('; ') || 'No query transformations applied' };
}

export const dataAnalyzerTool: ToolDefinition = {
  name: 'super.analyze-data',
  description: 'Analyze CSV or JSON data files: compute descriptive statistics (count, min, max, mean, median) and answer natural language queries (sort/filter/limit).',
  category: 'superpowers',
  timeout: 60_000,
  parameters: {
    path: { type: 'string', description: 'Absolute path to CSV or JSON file.', required: true },
    question: {
      type: 'string',
      description: 'Natural language query, e.g. "sort by revenue desc top 10" or "where age > 30".',
      required: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = params['path'] as string | undefined;
    const question = (params['question'] as string | undefined) ?? '';

    if (!filePath || typeof filePath !== 'string') {
      return { success: false, output: 'path is required.' };
    }

    logger.info({ session: ctx.sessionId, filePath, question }, 'Data analysis started');

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Cannot read file: ${msg}` };
    }

    const ext = extname(filePath).toLowerCase();
    let rows: Row[];

    try {
      if (ext === '.json') rows = parseJSON(content);
      else rows = parseCSV(content); // default to CSV for .csv and unknown
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Failed to parse file: ${msg}` };
    }

    logger.info({ filePath, rowCount: rows.length }, 'File parsed');

    const stats = computeStats(rows);
    const { rows: queryRows, note } = applyQuestion(rows, question);
    const queriedStats = computeStats(queryRows);

    const statLines = stats
      .map((s) => s.type === 'numeric'
        ? `  ${s.column}: count=${s.count} min=${s.min} max=${s.max} mean=${s.mean} median=${s.median} nulls=${s.nulls}`
        : `  ${s.column}: count=${s.count} unique=${s.unique} nulls=${s.nulls}`)
      .join('\n');

    const output = [
      `File: ${filePath} (${rows.length} rows, ${stats.length} columns)`,
      `\nColumn Statistics:\n${statLines}`,
      `\nQuery: "${question}"`,
      `Result: ${note} → ${queryRows.length} rows`,
    ].join('\n');

    logger.info({ filePath, resultRows: queryRows.length }, 'Analysis complete');

    return {
      success: true,
      output,
      data: { filePath, totalRows: rows.length, columns: stats.length, stats, queriedStats, queryNote: note, sampleRows: queryRows.slice(0, 20) },
    };
  },
};

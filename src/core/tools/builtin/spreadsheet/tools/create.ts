/**
 * @file create.ts
 * @description spreadsheet.create — Creates an XLSX workbook with styled headers using exceljs.
 */

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('spreadsheet:create');

const ALLOWED_DIRS = ['/tmp', dataPath('spreadsheets')];

function isAllowedPath(outputPath: string): boolean {
  const resolved = path.resolve(outputPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

export interface SheetColumn { header: string; key: string; width?: number }
export interface SheetDef { name: string; columns: SheetColumn[]; rows: Record<string, unknown>[] }

/**
 * Coerce the model's `sheets` argument into clean SheetDef[]. LLMs frequently pass
 * this deeply-nested array (sheets → columns/rows) as a JSON STRING, or stringify
 * the per-sheet `columns`/`rows` — normalise all of them, defaulting a column's
 * `key` to its header. Sheets without a name are dropped. Returns [] when nothing
 * usable is found. Pure + exported for unit testing.
 */
export function normalizeSheetsArg(raw: unknown): SheetDef[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];

  const parseArr = (v: unknown): unknown[] => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
    return Array.isArray(v) ? v : [];
  };

  const out: SheetDef[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['name'] !== 'string' || !o['name'].trim()) continue;
    const columns: SheetColumn[] = [];
    for (const c of parseArr(o['columns'])) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const header = typeof cc['header'] === 'string' ? cc['header'] : typeof cc['key'] === 'string' ? (cc['key'] as string) : '';
      if (!header.trim()) continue;
      const key = typeof cc['key'] === 'string' && cc['key'].trim() ? (cc['key'] as string) : header;
      columns.push({ header, key, ...(typeof cc['width'] === 'number' ? { width: cc['width'] as number } : {}) });
    }
    const rows = parseArr(o['rows']).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
    out.push({ name: o['name'].trim(), columns, rows });
  }
  return out;
}

export const spreadsheetCreateTool: ToolDefinition = {
  name: 'spreadsheet.create',
  description:
    'Create an XLSX workbook with one or more named sheets. Each sheet has typed columns and rows. ' +
    'Header rows are styled (bold, dark fill). Output must be under /tmp/ or data/spreadsheets/.',
  category: 'data',
  timeout: 20_000,
  parameters: {
    outputPath: {
      type: 'string',
      required: true,
      description: `Absolute output path ending in .xlsx. Must be under /tmp/ or ${PROJECT_ROOT}/data/spreadsheets/.`,
    },
    sheets: {
      type: 'array',
      required: true,
      description: 'Array of sheet definitions.',
      items: {
        type: 'object',
        description: 'A single sheet with name, columns, and rows.',
        properties: {
          name: { type: 'string', description: 'Sheet name.' },
          columns: {
            type: 'array',
            description: 'Column definitions.',
            items: {
              type: 'object',
              description: 'Column with header, key, and optional width.',
              properties: {
                header: { type: 'string', description: 'Column header label.' },
                key: { type: 'string', description: 'Key used to extract value from row objects.' },
                width: { type: 'number', description: 'Column width in characters (optional).' },
              },
            },
          },
          rows: {
            type: 'array',
            description: 'Array of row objects keyed by column keys.',
            items: { type: 'object', description: 'A row of data.', properties: {} },
          },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const outputPath = params['outputPath'] as string | undefined;

    logger.info({ session: ctx.sessionId, outputPath }, 'spreadsheet.create invoked');

    if (!outputPath?.trim()) {
      return { success: false, output: 'outputPath is required.' };
    }
    if (!isAllowedPath(outputPath)) {
      return {
        success: false,
        output: `outputPath must be under /tmp/ or ${PROJECT_ROOT}/data/spreadsheets/. Got: ${outputPath}`,
      };
    }

    const sheets = normalizeSheetsArg(params['sheets']);
    if (sheets.length === 0) {
      return { success: false, output: 'sheets must be a non-empty array of { name, columns[], rows[] } (a JSON string of that array is also accepted).' };
    }
    for (const sheet of sheets) {
      if (sheet.columns.length === 0) {
        return { success: false, output: `Sheet "${sheet.name}" must have at least one column.` };
      }
    }

    try {
      // Ensure output directory exists
      await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });

      // exceljs is CJS: its dynamic-import namespace exposes the API under `.default`,
      // not as named members — `(ns).Workbook` is undefined, so resolve `.default`.
      const ExcelJSmod = await import('exceljs');
      const ExcelJS = ExcelJSmod.default ?? ExcelJSmod;
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'SUDO-AI';
      workbook.created = new Date();

      let totalRows = 0;

      for (const sheetDef of sheets) {
        const ws = workbook.addWorksheet(sheetDef.name);

        // Set columns
        ws.columns = sheetDef.columns.map((col) => ({
          header: col.header,
          key: col.key,
          width: col.width ?? 15,
        }));

        // Style header row (row 1)
        const headerRow = ws.getRow(1);
        headerRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF2F4F7F' },
          };
          cell.border = {
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
          };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        headerRow.height = 20;

        // Add data rows
        const rows = Array.isArray(sheetDef.rows) ? sheetDef.rows : [];
        for (const row of rows) {
          ws.addRow(row);
          totalRows++;
        }

        // Freeze the header row
        ws.views = [{ state: 'frozen', ySplit: 1, activeCell: 'A2' }];
      }

      await workbook.xlsx.writeFile(outputPath);

      const fileInfo = await stat(outputPath);
      logger.info({ outputPath, sizeBytes: fileInfo.size, sheetCount: sheets.length, totalRows }, 'Workbook created');

      return {
        success: true,
        output: `Workbook created: ${outputPath} (${sheets.length} sheet(s), ${totalRows} row(s), ${fileInfo.size} bytes)`,
        data: {
          path: outputPath,
          sizeBytes: fileInfo.size,
          sheetCount: sheets.length,
          totalRows,
        },
        artifacts: [{ path: outputPath, action: 'created', size: fileInfo.size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ outputPath, err: msg }, 'spreadsheet.create error');
      return { success: false, output: `spreadsheet.create error: ${msg}` };
    }
  },
};

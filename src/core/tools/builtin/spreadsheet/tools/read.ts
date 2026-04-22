/**
 * @file read.ts
 * @description spreadsheet.read — Reads an XLSX workbook and returns structured row data.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('spreadsheet:read');

export const spreadsheetReadTool: ToolDefinition = {
  name: 'spreadsheet.read',
  description:
    'Read an XLSX workbook. Returns all sheets or a specific sheet as arrays of row objects. ' +
    'Optionally filter by sheet name and row range.',
  category: 'data',
  timeout: 10_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'Absolute path to the .xlsx file.',
    },
    sheet: {
      type: 'string',
      description: 'Sheet name to read (omit to read all sheets).',
    },
    range: {
      type: 'object',
      description: 'Optional row range filter.',
      properties: {
        startRow: { type: 'number', description: 'First data row (1-based, default: 2 to skip header).' },
        endRow: { type: 'number', description: 'Last data row inclusive (default: all).' },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = params['path'] as string | undefined;
    const sheetName = params['sheet'] as string | undefined;
    const range = params['range'] as { startRow?: number; endRow?: number } | undefined;

    logger.info({ session: ctx.sessionId, filePath, sheetName }, 'spreadsheet.read invoked');

    if (!filePath?.trim()) {
      return { success: false, output: 'path is required.' };
    }

    try {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);

      const startRow = range?.startRow ?? 2; // skip header by default
      const endRow = range?.endRow ?? Infinity;

      const sheetsData: Record<string, unknown[]> = {};
      let totalRows = 0;

      const worksheets = sheetName
        ? [workbook.getWorksheet(sheetName)].filter(Boolean)
        : workbook.worksheets;

      if (sheetName && worksheets.length === 0) {
        return { success: false, output: `Sheet "${sheetName}" not found in workbook.` };
      }

      for (const ws of worksheets) {
        if (!ws) continue;

        // Extract headers from row 1
        const headerRow = ws.getRow(1);
        const headers: string[] = [];
        headerRow.eachCell((cell, colNum) => {
          headers[colNum - 1] = String(cell.value ?? `col${colNum}`);
        });

        const rows: Record<string, unknown>[] = [];

        ws.eachRow((row, rowNumber) => {
          if (rowNumber < startRow) return;
          if (rowNumber > endRow) return;

          const obj: Record<string, unknown> = {};
          row.eachCell((cell, colNum) => {
            const key = headers[colNum - 1] ?? `col${colNum}`;
            // Handle formula cells
            const val = cell.value;
            if (val !== null && val !== undefined && typeof val === 'object' && 'result' in val) {
              obj[key] = (val as { result: unknown }).result;
            } else {
              obj[key] = val;
            }
          });
          rows.push(obj);
          totalRows++;
        });

        sheetsData[ws.name] = rows;
      }

      logger.info({ filePath, sheetCount: Object.keys(sheetsData).length, totalRows }, 'Workbook read');

      return {
        success: true,
        output: `Read ${totalRows} row(s) from ${Object.keys(sheetsData).length} sheet(s) in ${filePath}`,
        data: { sheets: sheetsData, totalRows },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ filePath, err: msg }, 'spreadsheet.read error');
      return { success: false, output: `spreadsheet.read error: ${msg}` };
    }
  },
};

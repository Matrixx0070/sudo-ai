/**
 * @file pivot.ts
 * @description spreadsheet.pivot — Reads source data and writes a pivot table to a new XLSX.
 * Uses plain JS Map aggregation since exceljs has no native pivot support.
 */

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('spreadsheet:pivot');

const ALLOWED_DIRS = ['/tmp', dataPath('spreadsheets')];

function isAllowedPath(outputPath: string): boolean {
  const resolved = path.resolve(outputPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

type AggFn = 'sum' | 'avg' | 'count' | 'max' | 'min';

interface ValueDef {
  col: string;
  agg: AggFn;
}

function aggregateValues(values: number[], agg: AggFn): number {
  if (values.length === 0) return 0;
  switch (agg) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'count': return values.length;
    case 'max': return Math.max(...values);
    case 'min': return Math.min(...values);
  }
}

export const spreadsheetPivotTool: ToolDefinition = {
  name: 'spreadsheet.pivot',
  description:
    'Compute a pivot table from a source XLSX sheet and write results to a new workbook. ' +
    'Aggregations: sum, avg, count, max, min. Uses pure JS — no native Excel pivot engine.',
  category: 'data',
  timeout: 20_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Absolute path to source .xlsx file.' },
    outputPath: {
      type: 'string',
      required: true,
      description: 'Absolute output path ending in .xlsx. Must be under /tmp/ or data/spreadsheets/.',
    },
    sourceSheet: { type: 'string', required: true, description: 'Name of the source sheet.' },
    rows: {
      type: 'array',
      required: true,
      description: 'Column keys to use as row labels.',
      items: { type: 'string', description: 'A column key.' },
    },
    columns: {
      type: 'array',
      required: true,
      description: 'Column keys to use as pivot columns.',
      items: { type: 'string', description: 'A column key.' },
    },
    values: {
      type: 'array',
      required: true,
      description: 'Value field definitions with aggregation function.',
      items: {
        type: 'object',
        description: 'A value with col and agg.',
        properties: {
          col: { type: 'string', description: 'Source column key.' },
          agg: { type: 'string', description: 'Aggregation: sum|avg|count|max|min.' },
        },
      },
    },
    pivotSheetName: { type: 'string', description: 'Name for the pivot sheet (default: Pivot).', default: 'Pivot' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const inputPath = params['inputPath'] as string | undefined;
    const outputPath = params['outputPath'] as string | undefined;
    const sourceSheetName = params['sourceSheet'] as string | undefined;
    const rowKeys = params['rows'] as string[] | undefined;
    const colKeys = params['columns'] as string[] | undefined;
    const valueDefs = params['values'] as ValueDef[] | undefined;
    const pivotSheetName = (params['pivotSheetName'] as string | undefined) ?? 'Pivot';

    logger.info({ session: ctx.sessionId, inputPath, outputPath, sourceSheetName }, 'spreadsheet.pivot invoked');

    if (!inputPath?.trim()) return { success: false, output: 'inputPath is required.' };
    if (!outputPath?.trim()) return { success: false, output: 'outputPath is required.' };
    if (!isAllowedPath(outputPath)) {
      return { success: false, output: `outputPath must be under /tmp/ or ${PROJECT_ROOT}/data/spreadsheets/. Got: ${outputPath}` };
    }
    if (!sourceSheetName?.trim()) return { success: false, output: 'sourceSheet is required.' };
    if (!rowKeys?.length) return { success: false, output: 'rows array is required.' };
    if (!colKeys?.length) return { success: false, output: 'columns array is required.' };
    if (!valueDefs?.length) return { success: false, output: 'values array is required.' };

    try {
      // exceljs is CJS — resolve `.default` from the dynamic-import namespace.
      const ExcelJSmod = await import('exceljs');
      const ExcelJS = ExcelJSmod.default ?? ExcelJSmod;

      // Read source workbook
      const srcWorkbook = new ExcelJS.Workbook();
      await srcWorkbook.xlsx.readFile(inputPath);
      const sourceSheet = srcWorkbook.getWorksheet(sourceSheetName);
      if (!sourceSheet) {
        return { success: false, output: `Sheet "${sourceSheetName}" not found in ${inputPath}.` };
      }

      // Extract headers from row 1
      const headerRow = sourceSheet.getRow(1);
      const headers: Record<number, string> = {};
      headerRow.eachCell((cell, colNum) => {
        headers[colNum] = String(cell.value ?? `col${colNum}`);
      });

      // Read all data rows
      const dataRows: Record<string, unknown>[] = [];
      sourceSheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return; // skip header
        const obj: Record<string, unknown> = {};
        row.eachCell((cell, colNum) => {
          const key = headers[colNum] ?? `col${colNum}`;
          const val = cell.value;
          if (val !== null && val !== undefined && typeof val === 'object' && 'result' in val) {
            obj[key] = (val as { result: unknown }).result;
          } else {
            obj[key] = val;
          }
        });
        dataRows.push(obj);
      });

      // Build pivot: Map<rowKey, Map<colKey, Map<valueKey, number[]>>>
      const pivotMap = new Map<string, Map<string, Map<string, number[]>>>();
      const allColValues = new Set<string>();

      for (const row of dataRows) {
        const rowLabel = rowKeys.map((k) => String(row[k] ?? '')).join(' | ');
        const colLabel = colKeys.map((k) => String(row[k] ?? '')).join(' | ');
        allColValues.add(colLabel);

        if (!pivotMap.has(rowLabel)) pivotMap.set(rowLabel, new Map());
        const colMap = pivotMap.get(rowLabel)!;
        if (!colMap.has(colLabel)) colMap.set(colLabel, new Map());
        const valMap = colMap.get(colLabel)!;

        for (const vd of valueDefs) {
          const valKey = `${vd.col}:${vd.agg}`;
          const raw = row[vd.col];
          const num = typeof raw === 'number' ? raw : parseFloat(String(raw ?? 0));
          if (!valMap.has(valKey)) valMap.set(valKey, []);
          if (!isNaN(num)) valMap.get(valKey)!.push(num);
        }
      }

      const sortedColValues = Array.from(allColValues).sort();
      const sortedRowLabels = Array.from(pivotMap.keys()).sort();

      // Build output workbook
      await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
      const outWorkbook = new ExcelJS.Workbook();
      outWorkbook.creator = 'SUDO-AI';
      const pivotWs = outWorkbook.addWorksheet(pivotSheetName);

      // Build header: row labels + (colValue x valueDef)
      const headers2: string[] = [...rowKeys];
      for (const colVal of sortedColValues) {
        for (const vd of valueDefs) {
          headers2.push(`${colVal} [${vd.col} ${vd.agg}]`);
        }
      }

      pivotWs.columns = headers2.map((h) => ({ header: h, key: h, width: 18 }));

      // Style header
      const hRow = pivotWs.getRow(1);
      hRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F7F' } };
        cell.alignment = { horizontal: 'center' };
      });

      // Fill pivot rows
      for (const rowLabel of sortedRowLabels) {
        const rowData: Record<string, unknown> = {};
        const parts = rowLabel.split(' | ');
        rowKeys.forEach((k, i) => { rowData[k] = parts[i] ?? ''; });

        const colMap = pivotMap.get(rowLabel)!;
        for (const colVal of sortedColValues) {
          const valMap = colMap.get(colVal);
          for (const vd of valueDefs) {
            const valKey = `${vd.col}:${vd.agg}`;
            const headerKey = `${colVal} [${vd.col} ${vd.agg}]`;
            const numbers = valMap?.get(valKey) ?? [];
            rowData[headerKey] = aggregateValues(numbers, vd.agg);
          }
        }

        pivotWs.addRow(rowData);
      }

      await outWorkbook.xlsx.writeFile(outputPath);
      const fileInfo = await stat(outputPath);

      logger.info({ outputPath, pivotRows: sortedRowLabels.length, pivotCols: sortedColValues.length }, 'Pivot created');

      return {
        success: true,
        output: `Pivot table created: ${outputPath} (${sortedRowLabels.length} rows, ${sortedColValues.length} column groups)`,
        data: {
          path: outputPath,
          sizeBytes: fileInfo.size,
          pivotRows: sortedRowLabels.length,
          pivotCols: sortedColValues.length,
        },
        artifacts: [{ path: outputPath, action: 'created', size: fileInfo.size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ inputPath, outputPath, err: msg }, 'spreadsheet.pivot error');
      return { success: false, output: `spreadsheet.pivot error: ${msg}` };
    }
  },
};

/**
 * @file index.ts
 * @description Spreadsheet toolkit — registers all spreadsheet tools into the ToolRegistry.
 *
 * Tools registered:
 *   spreadsheet.create   — Create XLSX workbook with styled headers
 *   spreadsheet.read     — Read XLSX workbook, return structured row data
 *   spreadsheet.pivot    — Compute pivot table from source sheet
 *   spreadsheet.chart    — Record chart metadata (exceljs limitation noted)
 *   spreadsheet.validate — Validate cells, check formula errors and broken refs
 */

import type { ToolRegistry } from '../../registry.js';
import { spreadsheetCreateTool } from './tools/create.js';
import { spreadsheetReadTool } from './tools/read.js';
import { spreadsheetPivotTool } from './tools/pivot.js';
import { spreadsheetChartTool } from './tools/chart.js';
import { spreadsheetValidateTool } from './tools/validate.js';

export const SPREADSHEET_TOOLS = [
  spreadsheetCreateTool,
  spreadsheetReadTool,
  spreadsheetPivotTool,
  spreadsheetChartTool,
  spreadsheetValidateTool,
] as const;

/**
 * Register all spreadsheet tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerSpreadsheetTools(registry: ToolRegistry): void {
  for (const tool of SPREADSHEET_TOOLS) {
    registry.register(tool);
  }
}

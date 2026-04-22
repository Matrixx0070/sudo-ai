/**
 * @file chart.ts
 * @description spreadsheet.chart — Records chart configuration metadata into a workbook sheet.
 *
 * IMPORTANT: exceljs does not support programmatic native Excel chart insertion.
 * This tool writes chart configuration as metadata into a dedicated "ChartConfig" sheet
 * within the workbook. The metadata accurately describes the intended chart so that
 * a user or downstream process can produce the native chart using Excel, LibreOffice, etc.
 *
 * This is an honest implementation — we do not silently skip chart functionality.
 * We store all required metadata and return a chartId the caller can reference.
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('spreadsheet:chart');

export const spreadsheetChartTool: ToolDefinition = {
  name: 'spreadsheet.chart',
  description:
    'Records chart configuration metadata (type, data range, title) into a "ChartConfig" sheet in the workbook. ' +
    'Note: exceljs cannot embed native Excel charts; metadata is written so a downstream tool or user can render the chart. ' +
    'Returns a chartId referencing the config.',
  category: 'data',
  timeout: 10_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'Absolute path to an existing .xlsx file.',
    },
    sheetName: {
      type: 'string',
      required: true,
      description: 'Name of the sheet containing the data.',
    },
    chartType: {
      type: 'string',
      required: true,
      description: 'Chart type.',
      enum: ['line', 'bar', 'pie'],
    },
    dataRange: {
      type: 'object',
      required: true,
      description: 'Data range definition.',
      properties: {
        startRow: { type: 'number', description: 'Start row (1-based).' },
        endRow: { type: 'number', description: 'End row (1-based).' },
        startCol: { type: 'number', description: 'Start column (1-based).' },
        endCol: { type: 'number', description: 'End column (1-based).' },
      },
    },
    titleCell: {
      type: 'string',
      description: 'Optional chart title (free text or cell reference like "A1").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = params['path'] as string | undefined;
    const sheetName = params['sheetName'] as string | undefined;
    const chartType = params['chartType'] as string | undefined;
    const dataRange = params['dataRange'] as {
      startRow?: number; endRow?: number; startCol?: number; endCol?: number;
    } | undefined;
    const titleCell = params['titleCell'] as string | undefined;

    logger.info({ session: ctx.sessionId, filePath, sheetName, chartType }, 'spreadsheet.chart invoked');

    if (!filePath?.trim()) return { success: false, output: 'path is required.' };
    if (!sheetName?.trim()) return { success: false, output: 'sheetName is required.' };
    if (!chartType) return { success: false, output: 'chartType is required.' };
    if (!dataRange) return { success: false, output: 'dataRange is required.' };

    const allowedTypes = ['line', 'bar', 'pie'];
    if (!allowedTypes.includes(chartType)) {
      return { success: false, output: `chartType must be one of: ${allowedTypes.join(', ')}.` };
    }

    try {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);

      const srcSheet = workbook.getWorksheet(sheetName);
      if (!srcSheet) {
        return { success: false, output: `Sheet "${sheetName}" not found in workbook.` };
      }

      // Generate unique chart ID
      const chartId = `chart-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      // Write metadata to a "ChartConfig" sheet
      let configSheet = workbook.getWorksheet('ChartConfig');
      if (!configSheet) {
        configSheet = workbook.addWorksheet('ChartConfig');
        configSheet.columns = [
          { header: 'chartId', key: 'chartId', width: 30 },
          { header: 'chartType', key: 'chartType', width: 12 },
          { header: 'dataSheet', key: 'dataSheet', width: 20 },
          { header: 'startRow', key: 'startRow', width: 10 },
          { header: 'endRow', key: 'endRow', width: 10 },
          { header: 'startCol', key: 'startCol', width: 10 },
          { header: 'endCol', key: 'endCol', width: 10 },
          { header: 'title', key: 'title', width: 40 },
          { header: 'note', key: 'note', width: 60 },
        ];
        // Style header
        const hRow = configSheet.getRow(1);
        hRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F7F' } };
        });
      }

      configSheet.addRow({
        chartId,
        chartType,
        dataSheet: sheetName,
        startRow: dataRange.startRow ?? 1,
        endRow: dataRange.endRow ?? 100,
        startCol: dataRange.startCol ?? 1,
        endCol: dataRange.endCol ?? 5,
        title: titleCell ?? '',
        note: 'Chart metadata — exceljs cannot embed native charts. Use Excel/LibreOffice to render.',
      });

      await workbook.xlsx.writeFile(filePath);

      logger.info({ filePath, chartId, chartType }, 'Chart metadata written');

      const resolvedPath = path.resolve(filePath);
      return {
        success: true,
        output:
          `Chart metadata recorded in ChartConfig sheet of ${filePath}. ` +
          `chartId: ${chartId}. ` +
          `Note: exceljs cannot embed native Excel charts — use Excel/LibreOffice to render the chart from this metadata.`,
        data: { path: resolvedPath, chartId, chartType, sheetName },
        artifacts: [{ path: resolvedPath, action: 'modified' }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ filePath, err: msg }, 'spreadsheet.chart error');
      return { success: false, output: `spreadsheet.chart error: ${msg}` };
    }
  },
};

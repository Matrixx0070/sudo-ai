/**
 * @file validate.ts
 * @description spreadsheet.validate — Opens a workbook and reports cell issues.
 * Checks for broken formula refs, missing sheet refs, and format warnings.
 * Circular reference detection is best-effort (static pattern scan).
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('spreadsheet:validate');

interface ValidationError {
  sheet: string;
  cell: string;
  type: string;
  message: string;
}

interface ValidationWarning {
  sheet: string;
  cell: string;
  type: string;
  message: string;
}

// Known error value strings from Excel
const EXCEL_ERROR_STRINGS = new Set(['#REF!', '#NAME?', '#DIV/0!', '#VALUE!', '#NULL!', '#NUM!', '#N/A', '#ERROR!']);

export const spreadsheetValidateTool: ToolDefinition = {
  name: 'spreadsheet.validate',
  description:
    'Open an XLSX workbook and validate all cells. Reports broken formula refs (#REF!, #NAME? etc.), ' +
    'missing sheet references, best-effort circular reference detection, and format warnings.',
  category: 'data',
  timeout: 10_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'Absolute path to the .xlsx file to validate.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = params['path'] as string | undefined;

    logger.info({ session: ctx.sessionId, filePath }, 'spreadsheet.validate invoked');

    if (!filePath?.trim()) {
      return { success: false, output: 'path is required.' };
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const ExcelJS = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);

      const sheetNames = workbook.worksheets.map((ws) => ws.name);

      for (const ws of workbook.worksheets) {
        ws.eachRow((row, rowNum) => {
          row.eachCell((cell, colNum) => {
            const addr = `${colIndexToLetter(colNum)}${rowNum}`;
            const val = cell.value;

            // Check for Excel error values in formula results
            if (typeof val === 'object' && val !== null && 'error' in val) {
              const errVal = (val as { error: string }).error;
              errors.push({
                sheet: ws.name,
                cell: addr,
                type: 'formula_error',
                message: `Formula error: ${errVal}`,
              });
              return;
            }

            // Check for error strings in regular cell values
            if (typeof val === 'string' && EXCEL_ERROR_STRINGS.has(val.trim())) {
              errors.push({
                sheet: ws.name,
                cell: addr,
                type: 'broken_ref',
                message: `Cell contains error value: ${val}`,
              });
            }

            // Check formula text for cross-sheet refs to non-existent sheets
            if (typeof val === 'object' && val !== null && 'formula' in val) {
              const formula = String((val as { formula: string }).formula);

              // Best-effort circular ref detection: formula references its own cell
              if (formula.includes(addr)) {
                warnings.push({
                  sheet: ws.name,
                  cell: addr,
                  type: 'possible_circular_ref',
                  message: `Formula may contain circular reference (references own cell ${addr}).`,
                });
              }

              // Check for sheet references in formula (SheetName!CellRef pattern)
              const sheetRefPattern = /'?([^'!]+)'?!/g;
              let match: RegExpExecArray | null;
              while ((match = sheetRefPattern.exec(formula)) !== null) {
                const referencedSheet = match[1]!.trim();
                if (!sheetNames.includes(referencedSheet)) {
                  errors.push({
                    sheet: ws.name,
                    cell: addr,
                    type: 'missing_sheet_ref',
                    message: `Formula references non-existent sheet: "${referencedSheet}"`,
                  });
                }
              }
            }

            // Format warning: mixed type in numeric column heuristic
            if (typeof val === 'string' && val.length > 0 && rowNum > 1) {
              const numericVal = parseFloat(val);
              if (!isNaN(numericVal) && val !== String(numericVal)) {
                // String that looks numeric but formatted as text
                warnings.push({
                  sheet: ws.name,
                  cell: addr,
                  type: 'format_warning',
                  message: `Numeric value stored as text: "${val}"`,
                });
              }
            }
          });
        });
      }

      const isValid = errors.length === 0;
      const summary = isValid
        ? `Workbook is valid. ${warnings.length} warning(s).`
        : `Workbook has ${errors.length} error(s) and ${warnings.length} warning(s).`;

      logger.info({ filePath, valid: isValid, errors: errors.length, warnings: warnings.length }, 'Validation complete');

      return {
        success: true,
        output: `${summary} Path: ${filePath}`,
        data: { valid: isValid, errors, warnings },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ filePath, err: msg }, 'spreadsheet.validate error');
      return { success: false, output: `spreadsheet.validate error: ${msg}` };
    }
  },
};

/** Convert a 1-based column number to an Excel letter (1→A, 26→Z, 27→AA). */
function colIndexToLetter(colNum: number): string {
  let letter = '';
  let n = colNum;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

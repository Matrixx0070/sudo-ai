/**
 * @file recalc.ts
 * @description spreadsheet.recalc — recalculate all formulas in an .xlsx with
 * LibreOffice and report formula errors (#REF!, #DIV/0!, …), wrapping the
 * vendored recalc.py from grok's xlsx skill. Complements the exceljs-based
 * tools, which can write formulas but never evaluate them. The file is updated
 * IN PLACE with stored computed values. recalc.py imports the shared office/
 * tree (vendored under builtin/docx/scripts), so we pass PYTHONPATH.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, realpath, stat } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('spreadsheet:recalc');
const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'recalc.py');
// recalc.py does `from office.soffice import …`; the shared office/ tree lives
// with the docx toolkit, so expose its parent dir on PYTHONPATH.
const OFFICE_PARENT = path.join(HERE, '..', '..', 'docx', 'scripts');

// Dedicated HOME for recalc's LibreOffice profile + macro. soffice cannot share
// a user profile across concurrent instances (the second run hangs on the lock,
// hits recalc.py's timeout, and the mtime guard reports failure) — isolating the
// profile keeps recalc independent of docx.convert/render soffice runs.
const LO_HOME = path.join(os.tmpdir(), 'sudo-lo-recalc-home');

const ALLOWED_DIRS = ['/tmp', dataPath('spreadsheets')];
function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

export const spreadsheetRecalcTool: ToolDefinition = {
  name: 'spreadsheet.recalc',
  description:
    'Recalculate every formula in an .xlsx/.xlsm with LibreOffice and report formula errors ' +
    '(#REF!, #DIV/0!, #VALUE!, #NAME?, #NULL!, #NUM!, #N/A) with cell locations. Updates the ' +
    'file IN PLACE with computed values. Run after creating or editing formulas — a model must ' +
    'ship with zero formula errors. Paths under /tmp/ or data/spreadsheets/.',
  category: 'data',
  timeout: 90_000,
  parameters: {
    inputPath: {
      type: 'string',
      required: true,
      description: `Absolute path to an existing .xlsx/.xlsm. Must be under /tmp/ or ${PROJECT_ROOT}/data/spreadsheets/.`,
    },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    if (!inputPath) return { success: false, output: 'spreadsheet.recalc error: inputPath is required' };
    if (!/\.(xlsx|xlsm)$/i.test(inputPath)) {
      return { success: false, output: 'spreadsheet.recalc error: inputPath must end in .xlsx or .xlsm' };
    }
    if (!isAllowedPath(inputPath)) {
      return { success: false, output: `spreadsheet.recalc error: inputPath must be under /tmp/ or ${PROJECT_ROOT}/data/spreadsheets/` };
    }
    try {
      await stat(inputPath);
      if (!isAllowedPath(await realpath(inputPath))) {
        return { success: false, output: `spreadsheet.recalc error: inputPath resolves outside allowed dirs: ${inputPath}` };
      }
    } catch {
      return { success: false, output: `spreadsheet.recalc error: file not found: ${inputPath}` };
    }

    const beforeMtime = (await stat(inputPath)).mtimeMs;
    try {
      await mkdir(LO_HOME, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: OFFICE_PARENT, HOME: LO_HOME };
      delete env['XDG_CONFIG_HOME']; // must not override the isolated HOME
      const { stdout } = await execFileAsync('python3', [SCRIPT, inputPath, '60'], {
        timeout: 80_000,
        maxBuffer: 8 * 1024 * 1024,
        env,
      });
      let report: Record<string, unknown>;
      try {
        report = JSON.parse(stdout);
      } catch {
        return { success: false, output: `spreadsheet.recalc error: unparseable output: ${stdout.slice(0, 400)}` };
      }
      if (report['error']) {
        logger.error({ inputPath, err: report['error'] }, 'spreadsheet.recalc script error');
        return { success: false, output: `spreadsheet.recalc error: ${String(report['error'])}` };
      }
      // recalc.py treats a timed-out soffice (exit 124) as success and then scans a
      // file that was never rewritten — seen live when libreoffice-calc was missing.
      // The macro always stores the workbook, so an unchanged mtime means it never ran.
      if ((await stat(inputPath)).mtimeMs === beforeMtime) {
        return {
          success: false,
          output:
            'spreadsheet.recalc error: LibreOffice did not rewrite the file — recalculation did not run ' +
            '(soffice hung or the Calc component is missing). Verify libreoffice-calc is installed.',
        };
      }
      logger.info({ inputPath, status: report['status'], totalErrors: report['total_errors'] }, 'spreadsheet.recalc ok');
      return {
        success: true,
        output: stdout.trim(),
        data: { inputPath, ...report },
        artifacts: [{ path: inputPath, action: 'modified' as const }],
      };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
      logger.error({ inputPath, err: msg }, 'spreadsheet.recalc error');
      return { success: false, output: `spreadsheet.recalc error: ${msg}` };
    }
  },
};

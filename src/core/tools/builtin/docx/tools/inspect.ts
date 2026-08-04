/**
 * @file inspect.ts
 * @description docx.inspect — read the structure, text, theme, and media of an
 * existing .docx/.dotx, complementing docx.create (which only writes). Wraps the
 * vendored Python inspector from grok's docx skill (python-docx + lxml), which
 * unpacks the OOXML and reports page setup, theme fonts/colors, styles, a text
 * summary, and a media inventory. The script is trusted first-party code run on a
 * local file under the same allowed dirs as docx.create.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('docx:inspect');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(dirname(), '..', 'scripts', 'inspect_doc.py');
function dirname(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const ALLOWED_DIRS = ['/tmp', dataPath('docx')];

function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

export const docxInspectTool: ToolDefinition = {
  name: 'docx.inspect',
  description:
    'Inspect an existing .docx/.dotx Word document: page setup, theme fonts/colors, styles, a ' +
    'text-content summary, section list, and media inventory. Read-only. Input must be under ' +
    '/tmp/ or data/docx/. Use this to understand a document before editing or summarising it.',
  category: 'content',
  timeout: 25_000,
  parameters: {
    inputPath: {
      type: 'string',
      required: true,
      description: `Absolute path to an existing .docx/.dotx. Must be under /tmp/ or ${PROJECT_ROOT}/data/docx/.`,
    },
    text: { type: 'boolean', required: false, description: 'Also include a text-content dump.' },
    sections: { type: 'boolean', required: false, description: 'Also include the section breakdown.' },
    media: { type: 'boolean', required: false, description: 'Also list embedded media files.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    if (!inputPath) return { success: false, output: 'docx.inspect error: inputPath is required' };
    if (!/\.(docx|dotx)$/i.test(inputPath)) {
      return { success: false, output: 'docx.inspect error: inputPath must end in .docx or .dotx' };
    }
    if (!isAllowedPath(inputPath)) {
      return { success: false, output: `docx.inspect error: inputPath must be under /tmp/ or ${PROJECT_ROOT}/data/docx/` };
    }
    try {
      await stat(inputPath);
    } catch {
      return { success: false, output: `docx.inspect error: file not found: ${inputPath}` };
    }

    const flags: string[] = [];
    if (args['text']) flags.push('--text');
    if (args['sections']) flags.push('--sections');
    if (args['media']) flags.push('--media');

    try {
      const { stdout } = await execFileAsync('python3', [SCRIPT, inputPath, ...flags], {
        timeout: 25_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      logger.info({ inputPath, flags }, 'docx.inspect ok');
      return { success: true, output: stdout.trim() || '(no output)', data: { inputPath, report: stdout } };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
      logger.error({ inputPath, err: msg }, 'docx.inspect error');
      return { success: false, output: `docx.inspect error: ${msg}` };
    }
  },
};

/**
 * @file inspect.ts
 * @description pptx.inspect — read the structure and text of an existing .pptx,
 * complementing pptx.create (which only writes). Wraps a small first-party
 * python-pptx inspector (the grok pptx skill reads decks via markitdown, which
 * is not installed; this reports the same information). Read-only, on a local
 * file under the same allowed dirs as pptx.create.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('pptx:inspect');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'inspect_pptx.py');

const ALLOWED_DIRS = ['/tmp', dataPath('pptx')];

function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

export const pptxInspectTool: ToolDefinition = {
  name: 'pptx.inspect',
  description:
    'Inspect an existing .pptx presentation: slide size, slide list with layout/title/shape ' +
    'counts, available layouts, and optionally per-slide text, speaker notes, and media ' +
    'inventory. Read-only. Input must be under /tmp/ or data/pptx/. Use this to understand a ' +
    'deck before editing or summarising it.',
  category: 'content',
  timeout: 25_000,
  parameters: {
    inputPath: {
      type: 'string',
      required: true,
      description: `Absolute path to an existing .pptx/.potx. Must be under /tmp/ or ${PROJECT_ROOT}/data/pptx/.`,
    },
    text: { type: 'boolean', required: false, description: 'Also dump every text frame per slide.' },
    notes: { type: 'boolean', required: false, description: 'Also dump speaker notes per slide.' },
    media: { type: 'boolean', required: false, description: 'Also list embedded media files.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    if (!inputPath) return { success: false, output: 'pptx.inspect error: inputPath is required' };
    if (!/\.(pptx|potx)$/i.test(inputPath)) {
      return { success: false, output: 'pptx.inspect error: inputPath must end in .pptx or .potx' };
    }
    if (!isAllowedPath(inputPath)) {
      return { success: false, output: `pptx.inspect error: inputPath must be under /tmp/ or ${PROJECT_ROOT}/data/pptx/` };
    }
    try {
      await stat(inputPath);
    } catch {
      return { success: false, output: `pptx.inspect error: file not found: ${inputPath}` };
    }

    const flags: string[] = [];
    if (args['text']) flags.push('--text');
    if (args['notes']) flags.push('--notes');
    if (args['media']) flags.push('--media');

    try {
      const { stdout } = await execFileAsync('python3', [SCRIPT, inputPath, ...flags], {
        timeout: 25_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      logger.info({ inputPath, flags }, 'pptx.inspect ok');
      return { success: true, output: stdout.trim() || '(no output)', data: { inputPath, report: stdout } };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
      logger.error({ inputPath, err: msg }, 'pptx.inspect error');
      return { success: false, output: `pptx.inspect error: ${msg}` };
    }
  },
};

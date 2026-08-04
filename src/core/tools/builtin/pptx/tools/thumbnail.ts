/**
 * @file thumbnail.ts
 * @description pptx.thumbnail — labeled slide-grid JPEG(s) for a .pptx, wrapping
 * the vendored thumbnail.py from grok's pptx skill (LibreOffice + pdftoppm +
 * PIL; hidden slides shown as placeholders, each thumbnail labeled with its
 * slideN.xml filename). The pptx analogue of docx.render — use it to analyse a
 * template's layouts before editing, or to eyeball a deck after edits.
 * thumbnail.py imports the shared office/ tree (vendored under
 * builtin/docx/scripts), so we pass PYTHONPATH.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, realpath, stat } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('pptx:thumbnail');
const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'thumbnail.py');
const OFFICE_PARENT = path.join(HERE, '..', '..', 'docx', 'scripts');

const ALLOWED_DIRS = ['/tmp', dataPath('pptx')];
function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}
const ALLOWED_MSG = `must be under /tmp/ or ${PROJECT_ROOT}/data/pptx/`;

async function isRealPathAllowed(p: string, kind: 'input' | 'output'): Promise<boolean> {
  try {
    if (kind === 'input') return isAllowedPath(await realpath(p));
    const realParent = await realpath(path.dirname(p));
    return isAllowedPath(path.join(realParent, path.basename(p)));
  } catch {
    return false;
  }
}

/** First LibreOffice run on a fresh profile can take ~30s; steady state is <3s. */
const PY_TIMEOUT = 120_000;

export const pptxThumbnailTool: ToolDefinition = {
  name: 'pptx.thumbnail',
  description:
    'Render a .pptx as labeled slide-thumbnail grid JPEG(s) (LibreOffice + pdftoppm). Each ' +
    'thumbnail is labeled with its slideN.xml filename; hidden slides show a placeholder. Writes ' +
    '`<outputPrefix>.jpg` (or -1.jpg, -2.jpg… for large decks). Use to analyse a template\'s ' +
    'layouts before editing or to eyeball a deck after edits. Paths under /tmp/ or data/pptx/.',
  category: 'content',
  timeout: PY_TIMEOUT + 10_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .pptx to render.' },
    outputPrefix: {
      type: 'string',
      required: false,
      description: 'Path prefix for the grid JPEG(s). Default: `<input dir>/<input stem>_thumbnails`.',
    },
    cols: { type: 'number', required: false, description: 'Grid columns (1–6, default 3).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    if (!inputPath) return { success: false, output: 'pptx.thumbnail error: inputPath is required' };
    if (!/\.pptx$/i.test(inputPath)) {
      return { success: false, output: 'pptx.thumbnail error: inputPath must end in .pptx' };
    }
    if (!isAllowedPath(inputPath)) {
      return { success: false, output: `pptx.thumbnail error: inputPath ${ALLOWED_MSG}` };
    }
    try {
      await stat(inputPath);
    } catch {
      return { success: false, output: `pptx.thumbnail error: file not found: ${inputPath}` };
    }
    if (!(await isRealPathAllowed(inputPath, 'input'))) {
      return { success: false, output: `pptx.thumbnail error: inputPath resolves outside allowed dirs: ${inputPath}` };
    }

    const stem = path.basename(inputPath).replace(/\.[^.]+$/, '');
    const prefix = args['outputPrefix']
      ? String(args['outputPrefix'])
      : path.join(path.dirname(path.resolve(inputPath)), `${stem}_thumbnails`);
    if (!isAllowedPath(prefix)) return { success: false, output: `pptx.thumbnail error: outputPrefix ${ALLOWED_MSG}` };
    if (!(await isRealPathAllowed(`${prefix}.jpg`, 'output'))) {
      return { success: false, output: `pptx.thumbnail error: outputPrefix resolves outside allowed dirs: ${prefix}` };
    }

    const extra: string[] = [];
    const cols = Number(args['cols']);
    if (Number.isInteger(cols) && cols >= 1 && cols <= 6) extra.push('--cols', String(cols));

    try {
      const { stdout } = await execFileAsync('python3', [SCRIPT, inputPath, prefix, ...extra], {
        timeout: PY_TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONPATH: OFFICE_PARENT },
      });
      const dir = path.dirname(prefix);
      const base = path.basename(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const created = (await readdir(dir))
        .filter((f) => new RegExp(`^${base}(-\\d+)?\\.jpg$`).test(f))
        .sort()
        .map((f) => path.join(dir, f));
      logger.info({ inputPath, prefix, created: created.length }, 'pptx.thumbnail ok');
      return {
        success: true,
        output: stdout.trim() || `rendered → ${created.join(', ')}`,
        data: { inputPath, created },
        artifacts: created.map((p) => ({ path: p, action: 'created' as const })),
      };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
      logger.error({ inputPath, err: msg }, 'pptx.thumbnail error');
      return { success: false, output: `pptx.thumbnail error: ${msg}` };
    }
  },
};

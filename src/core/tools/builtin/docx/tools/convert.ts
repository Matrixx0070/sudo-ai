/**
 * @file convert.ts
 * @description docx.convert + docx.render — LibreOffice-backed conversion for
 * Word documents, wrapping the vendored convert_doc.py / render_doc.py from
 * grok's docx skill. convert: .doc/.dotx→.docx, .docx→pdf, .docx→per-page JPEGs.
 * render: single labeled page-grid JPEG for visual inspection. Requires the
 * system `soffice` binary (libreoffice-writer) and `pdftoppm` (poppler-utils);
 * both tools report a clear error if missing. Paths confined to /tmp or
 * data/docx, same as the other docx tools.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('docx:convert');
const execFileAsync = promisify(execFile);

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

const ALLOWED_DIRS = ['/tmp', dataPath('docx')];
function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}
const ALLOWED_MSG = `must be under /tmp/ or ${PROJECT_ROOT}/data/docx/`;

async function isRealPathAllowed(p: string, kind: 'input' | 'output'): Promise<boolean> {
  try {
    if (kind === 'input') return isAllowedPath(await realpath(p));
    const realParent = await realpath(path.dirname(p));
    return isAllowedPath(path.join(realParent, path.basename(p)));
  } catch {
    return false;
  }
}

/**
 * Symlink-safe check for an output *directory*: if it exists in any form
 * (lstat — including as a dangling symlink) it must fully realpath inside the
 * allowlist; only a genuinely absent path falls back to the parent-dir check.
 */
async function isDirReallyAllowed(dir: string): Promise<boolean> {
  try {
    await lstat(dir);
    return isRealPathAllowed(dir, 'input');
  } catch {
    return isRealPathAllowed(dir, 'output');
  }
}

/** First LibreOffice run on a fresh profile can take ~30s; steady state is <2s. */
const PY_TIMEOUT = 120_000;

async function py(script: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('python3', [script, ...args], {
    timeout: PY_TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function validateInput(inputPath: string, extensions: RegExp): Promise<string | null> {
  if (!inputPath) return 'inputPath is required';
  if (!extensions.test(inputPath)) return `inputPath has an unsupported extension for this operation`;
  if (!isAllowedPath(inputPath)) return `inputPath ${ALLOWED_MSG}`;
  try {
    await stat(inputPath);
  } catch {
    return `file not found: ${inputPath}`;
  }
  if (!(await isRealPathAllowed(inputPath, 'input'))) {
    return `inputPath resolves outside allowed dirs: ${inputPath}`;
  }
  return null;
}

function errMsg(err: unknown): string {
  const e = err as { stderr?: string; message?: string; code?: string };
  const raw = e.stderr?.trim() || e.message || String(err);
  if (raw.includes('soffice') && (raw.includes('not found') || raw.includes('ENOENT'))) {
    return 'LibreOffice (soffice) is not installed — install libreoffice-writer to enable conversion';
  }
  return raw.slice(0, 800);
}

// ---------------------------------------------------------------------------
// docx.convert
// ---------------------------------------------------------------------------

const CONVERT_INPUT_EXT: Record<string, RegExp> = {
  pdf: /\.(docx|doc|dotx)$/i,
  images: /\.(docx|doc|dotx)$/i,
  docx: /\.(doc|dotx)$/i,
};

export const docxConvertTool: ToolDefinition = {
  name: 'docx.convert',
  description:
    'Convert Word documents with LibreOffice: .docx/.doc/.dotx → PDF (`to: "pdf"`), → per-page ' +
    'JPEG images (`to: "images"`), or legacy .doc/.dotx → .docx (`to: "docx"`). Writes into ' +
    '`outputDir` (default: alongside the input) using the input\'s basename. Paths under /tmp/ ' +
    'or data/docx/.',
  category: 'content',
  timeout: PY_TIMEOUT + 10_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .docx/.doc/.dotx to convert.' },
    to: { type: 'string', required: true, description: 'Target format: "pdf", "images", or "docx".' },
    outputDir: { type: 'string', required: false, description: 'Directory for the output file(s). Default: the input\'s directory.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const to = String(args['to'] ?? '');
    if (!(to in CONVERT_INPUT_EXT)) {
      return { success: false, output: 'docx.convert error: `to` must be "pdf", "images", or "docx"' };
    }
    const invalid = await validateInput(inputPath, CONVERT_INPUT_EXT[to]!);
    if (invalid) return { success: false, output: `docx.convert error: ${invalid}` };

    const outputDir = args['outputDir'] ? String(args['outputDir']) : path.dirname(path.resolve(inputPath));
    if (!isAllowedPath(outputDir)) return { success: false, output: `docx.convert error: outputDir ${ALLOWED_MSG}` };
    if (!(await isDirReallyAllowed(outputDir))) {
      return { success: false, output: `docx.convert error: outputDir resolves outside allowed dirs: ${outputDir}` };
    }

    try {
      const out = await py(path.join(SCRIPTS, 'convert_doc.py'), [inputPath, '--to', to, '--outdir', outputDir]);
      const stem = path.basename(inputPath).replace(/\.[^.]+$/, '');
      const created =
        to === 'images'
          ? (await readdir(outputDir)).filter((f) => /^page-\d+\.jpg$/.test(f)).sort().map((f) => path.join(outputDir, f))
          : [path.join(outputDir, `${stem}.${to === 'pdf' ? 'pdf' : 'docx'}`)];
      logger.info({ inputPath, to, outputDir, created: created.length }, 'docx.convert ok');
      return {
        success: true,
        output: out.trim() || `converted → ${created.join(', ')}`,
        data: { inputPath, to, created },
        artifacts: created.map((p) => ({ path: p, action: 'created' as const })),
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, to, err: msg }, 'docx.convert error');
      return { success: false, output: `docx.convert error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// docx.render
// ---------------------------------------------------------------------------

export const docxRenderTool: ToolDefinition = {
  name: 'docx.render',
  description:
    'Render a Word document as a single labeled page-grid JPEG for quick visual inspection ' +
    '(LibreOffice + pdftoppm). Writes `<outputPrefix>.jpg` (or -1.jpg, -2.jpg… for long docs). ' +
    'Use after edits to eyeball layout without opening Word. Paths under /tmp/ or data/docx/.',
  category: 'content',
  timeout: PY_TIMEOUT + 10_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .docx/.doc/.dotx to render.' },
    outputPrefix: {
      type: 'string',
      required: false,
      description: 'Path prefix for the grid JPEG(s). Default: `<input dir>/<input stem>_pages`.',
    },
    cols: { type: 'number', required: false, description: 'Grid columns (1–6, default 2).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = await validateInput(inputPath, /\.(docx|doc|dotx)$/i);
    if (invalid) return { success: false, output: `docx.render error: ${invalid}` };

    const stem = path.basename(inputPath).replace(/\.[^.]+$/, '');
    const prefix = args['outputPrefix']
      ? String(args['outputPrefix'])
      : path.join(path.dirname(path.resolve(inputPath)), `${stem}_pages`);
    if (!isAllowedPath(prefix)) return { success: false, output: `docx.render error: outputPrefix ${ALLOWED_MSG}` };
    if (!(await isRealPathAllowed(`${prefix}.jpg`, 'output'))) {
      return { success: false, output: `docx.render error: outputPrefix resolves outside allowed dirs: ${prefix}` };
    }

    const extra: string[] = [];
    const cols = Number(args['cols']);
    if (Number.isInteger(cols) && cols >= 1 && cols <= 6) extra.push('--cols', String(cols));

    try {
      const out = await py(path.join(SCRIPTS, 'render_doc.py'), [inputPath, prefix, ...extra]);
      const dir = path.dirname(prefix);
      const base = path.basename(prefix);
      const created = (await readdir(dir))
        .filter((f) => f === `${base}.jpg` || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.jpg$`).test(f))
        .sort()
        .map((f) => path.join(dir, f));
      logger.info({ inputPath, prefix, created: created.length }, 'docx.render ok');
      return {
        success: true,
        output: out.trim() || `rendered → ${created.join(', ')}`,
        data: { inputPath, created },
        artifacts: created.map((p) => ({ path: p, action: 'created' as const })),
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, err: msg }, 'docx.render error');
      return { success: false, output: `docx.render error: ${msg}` };
    }
  },
};

/**
 * @file edit.ts
 * @description pptx.unpack + pptx.add_slide + pptx.clean + pptx.pack — the
 * template-editing workflow from grok's pptx skill, wrapping its vendored Python
 * scripts. Unlike docx (where scripts perform the edits), the pptx skill's edit
 * step is direct XML editing between unpack and pack, so these tools expose the
 * workflow primitives: unpack a deck to a directory, duplicate/add slides,
 * remove orphaned parts, and pack (with validation) back to a .pptx. The agent
 * edits `ppt/slides/slide*.xml` in the unpacked directory with its file tools
 * between steps. unpack/pack reuse the office/ scripts vendored under
 * builtin/docx/scripts (one shared copy; the two skill trees ship identical
 * office/ code). All paths confined to /tmp or data/pptx.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('pptx:edit');
const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
// Shared vendored office/ tree lives with the docx toolkit (identical in both skill trees).
const OFFICE = path.join(HERE, '..', '..', 'docx', 'scripts', 'office');
const UNPACK = path.join(OFFICE, 'unpack.py');
const PACK = path.join(OFFICE, 'pack.py');

const ALLOWED_DIRS = ['/tmp', dataPath('pptx')];
function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}
const ALLOWED_MSG = `must be under /tmp/ or ${PROJECT_ROOT}/data/pptx/`;

/**
 * Symlink-safe allowlist check. `path.resolve` normalises `..` but does NOT
 * dereference symlinks, so a symlink inside an allowed dir could point out of it.
 * We realpath the actual target (for an existing input) or its parent dir (for a
 * not-yet-created output) and re-check the allowlist on the real location.
 */
async function isRealPathAllowed(p: string, kind: 'input' | 'output'): Promise<boolean> {
  try {
    if (kind === 'input') return isAllowedPath(await realpath(p));
    // output may not exist yet: resolve the parent's real path, then re-attach the basename.
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

async function py(script: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('python3', [script, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** Validate that `dir` is an allowed, existing unpacked-PPTX directory. */
async function validateUnpackedDir(dir: string): Promise<string | null> {
  if (!dir) return 'dir is required';
  if (!isAllowedPath(dir)) return `dir ${ALLOWED_MSG}`;
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return `not a directory: ${dir}`;
  } catch {
    return `directory not found: ${dir}`;
  }
  if (!(await isRealPathAllowed(dir, 'input'))) return `dir resolves outside allowed dirs: ${dir}`;
  try {
    await stat(path.join(dir, 'ppt', 'presentation.xml'));
  } catch {
    return `not an unpacked PPTX (missing ppt/presentation.xml): ${dir}`;
  }
  return null;
}

function fail(tool: string, msg: string): ToolResult {
  return { success: false, output: `${tool} error: ${msg}` };
}

function errMsg(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
}

// ---------------------------------------------------------------------------
// pptx.unpack
// ---------------------------------------------------------------------------

export const pptxUnpackTool: ToolDefinition = {
  name: 'pptx.unpack',
  description:
    'Unpack an existing .pptx into a directory of pretty-printed OOXML for editing. Slide order ' +
    'lives in ppt/presentation.xml <p:sldIdLst>; slide content in ppt/slides/slide{N}.xml. Edit ' +
    'those files directly, then pptx.clean + pptx.pack to produce the new deck. Paths under ' +
    '/tmp/ or data/pptx/.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .pptx/.potx to unpack.' },
    outputDir: { type: 'string', required: true, description: 'Directory to unpack into (created; must not already contain files).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const outputDir = String(args['outputDir'] ?? '');
    if (!inputPath) return fail('pptx.unpack', 'inputPath is required');
    if (!/\.(pptx|potx)$/i.test(inputPath)) return fail('pptx.unpack', 'inputPath must end in .pptx or .potx');
    if (!isAllowedPath(inputPath)) return fail('pptx.unpack', `inputPath ${ALLOWED_MSG}`);
    try {
      await stat(inputPath);
    } catch {
      return fail('pptx.unpack', `file not found: ${inputPath}`);
    }
    if (!(await isRealPathAllowed(inputPath, 'input'))) {
      return fail('pptx.unpack', `inputPath resolves outside allowed dirs: ${inputPath}`);
    }
    if (!outputDir) return fail('pptx.unpack', 'outputDir is required');
    if (!isAllowedPath(outputDir)) return fail('pptx.unpack', `outputDir ${ALLOWED_MSG}`);
    if (!(await isDirReallyAllowed(outputDir))) {
      return fail('pptx.unpack', `outputDir resolves outside allowed dirs: ${outputDir}`);
    }
    try {
      const existing = await readdir(outputDir);
      if (existing.length > 0) return fail('pptx.unpack', `outputDir is not empty: ${outputDir}`);
    } catch {
      // does not exist yet — unpack.py creates it
    }

    try {
      const out = await py(UNPACK, [inputPath, outputDir]);
      const slides = (await readdir(path.join(outputDir, 'ppt', 'slides')).catch(() => []))
        .filter((f) => /^slide\d+\.xml$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
      const layouts = (await readdir(path.join(outputDir, 'ppt', 'slideLayouts')).catch(() => []))
        .filter((f) => f.endsWith('.xml'))
        .sort();
      logger.info({ inputPath, outputDir, slides: slides.length }, 'pptx.unpack ok');
      return {
        success: true,
        output:
          `Unpacked ${inputPath} → ${outputDir}\n` +
          `Slides (${slides.length}): ${slides.join(', ') || '(none)'}\n` +
          `Layouts: ${layouts.join(', ') || '(none)'}\n` +
          (out.trim() ? out.trim() + '\n' : '') +
          'Slide order: ppt/presentation.xml <p:sldIdLst>. Edit slide XML, then pptx.clean + pptx.pack.',
        data: { inputPath, outputDir, slides, layouts },
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ inputPath, outputDir, err: msg }, 'pptx.unpack error');
      return fail('pptx.unpack', msg);
    }
  },
};

// ---------------------------------------------------------------------------
// pptx.add_slide
// ---------------------------------------------------------------------------

export const pptxAddSlideTool: ToolDefinition = {
  name: 'pptx.add_slide',
  description:
    'Add a slide to an unpacked PPTX directory (from pptx.unpack): duplicate an existing slide ' +
    '(`source: "slide2.xml"`) or create a blank one from a layout (`source: "slideLayout2.xml"`). ' +
    'Handles rels and Content_Types. The output includes a <p:sldId> element you must then insert ' +
    'into ppt/presentation.xml <p:sldIdLst> at the desired position.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    dir: { type: 'string', required: true, description: 'Unpacked PPTX directory (from pptx.unpack).' },
    source: {
      type: 'string',
      required: true,
      description: 'Slide to duplicate ("slide2.xml") or layout to instantiate ("slideLayout2.xml").',
    },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const dir = String(args['dir'] ?? '');
    const source = String(args['source'] ?? '');
    const invalid = await validateUnpackedDir(dir);
    if (invalid) return fail('pptx.add_slide', invalid);
    if (!/^slide(Layout)?\d+\.xml$/.test(source)) {
      return fail('pptx.add_slide', 'source must look like "slide2.xml" or "slideLayout2.xml"');
    }

    try {
      const out = await py(path.join(SCRIPTS, 'add_slide.py'), [dir, source]);
      logger.info({ dir, source }, 'pptx.add_slide ok');
      return { success: true, output: out.trim() || 'done', data: { dir, source } };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ dir, source, err: msg }, 'pptx.add_slide error');
      return fail('pptx.add_slide', msg);
    }
  },
};

// ---------------------------------------------------------------------------
// pptx.clean
// ---------------------------------------------------------------------------

export const pptxCleanTool: ToolDefinition = {
  name: 'pptx.clean',
  description:
    'Remove orphaned parts from an unpacked PPTX directory: slides missing from <p:sldIdLst>, ' +
    'unreferenced media/themes/notes, dangling rels and Content-Type overrides. Run after ' +
    'deleting or reordering slides, before pptx.pack.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    dir: { type: 'string', required: true, description: 'Unpacked PPTX directory (from pptx.unpack).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const dir = String(args['dir'] ?? '');
    const invalid = await validateUnpackedDir(dir);
    if (invalid) return fail('pptx.clean', invalid);

    try {
      const out = await py(path.join(SCRIPTS, 'clean.py'), [dir]);
      logger.info({ dir }, 'pptx.clean ok');
      return { success: true, output: out.trim() || 'done (nothing to remove)', data: { dir } };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ dir, err: msg }, 'pptx.clean error');
      return fail('pptx.clean', msg);
    }
  },
};

// ---------------------------------------------------------------------------
// pptx.pack
// ---------------------------------------------------------------------------

export const pptxPackTool: ToolDefinition = {
  name: 'pptx.pack',
  description:
    'Pack an unpacked PPTX directory back into a .pptx (validates and auto-repairs, condenses ' +
    'XML, re-encodes smart quotes). Pass `originalPath` (the deck given to pptx.unpack) to enable ' +
    'schema validation against it. Paths under /tmp/ or data/pptx/.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    dir: { type: 'string', required: true, description: 'Unpacked PPTX directory (from pptx.unpack).' },
    outputPath: { type: 'string', required: true, description: 'Where to write the .pptx.' },
    originalPath: {
      type: 'string',
      required: false,
      description: 'The original .pptx the directory was unpacked from, for validation.',
    },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const dir = String(args['dir'] ?? '');
    const outputPath = String(args['outputPath'] ?? '');
    const invalid = await validateUnpackedDir(dir);
    if (invalid) return fail('pptx.pack', invalid);
    if (!outputPath) return fail('pptx.pack', 'outputPath is required');
    if (!/\.pptx$/i.test(outputPath)) return fail('pptx.pack', 'outputPath must end in .pptx');
    if (!isAllowedPath(outputPath)) return fail('pptx.pack', `outputPath ${ALLOWED_MSG}`);
    if (!(await isRealPathAllowed(outputPath, 'output'))) {
      return fail('pptx.pack', `outputPath resolves outside allowed dirs: ${outputPath}`);
    }

    const packArgs = [dir, outputPath];
    const originalPath = args['originalPath'] ? String(args['originalPath']) : '';
    if (originalPath) {
      if (!isAllowedPath(originalPath)) return fail('pptx.pack', `originalPath ${ALLOWED_MSG}`);
      try {
        await stat(originalPath);
      } catch {
        return fail('pptx.pack', `originalPath not found: ${originalPath}`);
      }
      packArgs.push('--original', originalPath);
    }

    try {
      const out = await py(PACK, packArgs);
      logger.info({ dir, outputPath, originalPath }, 'pptx.pack ok');
      return {
        success: true,
        output: out.trim() || `packed → ${outputPath}`,
        data: { dir, outputPath },
        artifacts: [{ path: outputPath, action: 'modified' as const }],
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ dir, outputPath, err: msg }, 'pptx.pack error');
      return fail('pptx.pack', msg);
    }
  },
};

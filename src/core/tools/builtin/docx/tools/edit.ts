/**
 * @file edit.ts
 * @description docx.replace_text + docx.patch — edit an existing .docx while
 * preserving formatting, wrapping grok's vendored Python edit scripts. Those
 * scripts operate on an *unpacked* OOXML directory, so each tool runs the full
 * round-trip internally: office/unpack.py → <edit script> → office/pack.py, in a
 * throwaway temp dir. Writes to `outputPath` (or overwrites the input). `dryRun`
 * previews the change and never writes. Read/write confined to /tmp or data/docx.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, stat, writeFile, realpath } from 'node:fs/promises';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('docx:edit');
const execFileAsync = promisify(execFile);

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const UNPACK = path.join(SCRIPTS, 'office', 'unpack.py');
const PACK = path.join(SCRIPTS, 'office', 'pack.py');

const ALLOWED_DIRS = ['/tmp', dataPath('docx')];
function isAllowedPath(p: string): boolean {
  const resolved = path.resolve(p);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}
const ALLOWED_MSG = `must be under /tmp/ or ${PROJECT_ROOT}/data/docx/`;

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

async function py(script: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('python3', [script, ...args], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  return stdout;
}

interface EditOutcome {
  ok: boolean;
  output: string;
  outputPath?: string;
}

/**
 * Run `<editScript> <unpackedDir> <editArgs>` inside an unpack→edit→pack round
 * trip. On dryRun, runs the edit with `--dry-run` and skips packing. Returns the
 * edit script's stdout plus, when written, the output path.
 */
async function unpackEditPack(
  inputPath: string,
  outputPath: string,
  editScript: string,
  editArgs: string[],
  dryRun: boolean,
): Promise<EditOutcome> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'docxedit-'));
  const unpacked = path.join(tmp, 'unpacked');
  try {
    await py(UNPACK, [inputPath, unpacked]);
    const editOut = await py(editScript, [unpacked, ...editArgs, ...(dryRun ? ['--dry-run'] : [])]);
    if (dryRun) return { ok: true, output: editOut.trim() };
    await py(PACK, [unpacked, outputPath]);
    return { ok: true, output: editOut.trim(), outputPath };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function validateInput(inputPath: string): Promise<string | null> {
  if (!inputPath) return 'inputPath is required';
  if (!/\.(docx|dotx)$/i.test(inputPath)) return 'inputPath must end in .docx or .dotx';
  if (!isAllowedPath(inputPath)) return `inputPath ${ALLOWED_MSG}`;
  try {
    await stat(inputPath);
  } catch {
    return `file not found: ${inputPath}`;
  }
  if (!(await isRealPathAllowed(inputPath, 'input'))) {
    return `inputPath resolves outside allowed dirs (symlink): ${inputPath}`;
  }
  return null;
}

/** Resolve the destination: explicit outputPath (validated) or in-place overwrite. */
function resolveOutput(inputPath: string, args: Record<string, unknown>): { outputPath: string } | { error: string } {
  const raw = args['outputPath'];
  if (raw === undefined || raw === null || raw === '') return { outputPath: inputPath };
  const out = String(raw);
  if (!/\.docx$/i.test(out)) return { error: 'outputPath must end in .docx' };
  if (!isAllowedPath(out)) return { error: `outputPath ${ALLOWED_MSG}` };
  return { outputPath: out };
}

// ---------------------------------------------------------------------------
// docx.replace_text
// ---------------------------------------------------------------------------

export const docxReplaceTextTool: ToolDefinition = {
  name: 'docx.replace_text',
  description:
    'Find-and-replace text in an existing .docx while preserving formatting. Provide either ' +
    '`match` + `text` for a single replacement, or `map` ({old: new}) for many. Set `dryRun` to ' +
    'preview. Writes to `outputPath` or overwrites the input. Paths under /tmp/ or data/docx/.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .docx to edit.' },
    match: { type: 'string', required: false, description: 'Text to find (case-insensitive). Pair with `text`.' },
    text: { type: 'string', required: false, description: 'Replacement text for `match`.' },
    map: { type: 'object', required: false, description: 'Object of {oldText: newText} for multiple replacements.' },
    outputPath: { type: 'string', required: false, description: 'Where to write (.docx). Omit to overwrite the input.' },
    allFiles: { type: 'boolean', required: false, description: 'Also replace in headers/footers.' },
    dryRun: { type: 'boolean', required: false, description: 'Preview changes without writing.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = await validateInput(inputPath);
    if (invalid) return { success: false, output: `docx.replace_text error: ${invalid}` };

    const hasMatch = typeof args['match'] === 'string' && args['match'] !== '';
    const hasMap = args['map'] && typeof args['map'] === 'object';
    if (!hasMatch && !hasMap) {
      return { success: false, output: 'docx.replace_text error: provide `match` (+`text`) or `map`' };
    }

    const out = resolveOutput(inputPath, args);
    if ('error' in out) return { success: false, output: `docx.replace_text error: ${out.error}` };
    const dryRun = args['dryRun'] === true;
    if (!dryRun && !(await isRealPathAllowed(out.outputPath, 'output'))) {
      return { success: false, output: `docx.replace_text error: outputPath resolves outside allowed dirs: ${out.outputPath}` };
    }

    let mapFile: string | undefined;
    try {
      const editArgs: string[] = [];
      if (hasMatch) {
        editArgs.push('--match', String(args['match']));
        if (typeof args['text'] === 'string') editArgs.push('--text', String(args['text']));
      }
      if (hasMap) {
        mapFile = path.join(os.tmpdir(), `docxmap-${process.pid}-${Date.now()}.json`);
        await writeFile(mapFile, JSON.stringify(args['map']), 'utf8');
        editArgs.push('--map', mapFile);
      }
      if (args['allFiles'] === true) editArgs.push('--all-files');

      // Overwrite is safe: we pack from the temp copy to the destination only on success.
      const script = path.join(SCRIPTS, 'replace_text.py');
      const r = await unpackEditPack(inputPath, out.outputPath, script, editArgs, dryRun);
      logger.info({ inputPath, outputPath: r.outputPath, dryRun }, 'docx.replace_text ok');
      return {
        success: true,
        output: (dryRun ? '[dry-run] ' : '') + (r.output || 'done'),
        data: { inputPath, outputPath: r.outputPath, dryRun },
        ...(r.outputPath ? { artifacts: [{ path: r.outputPath, action: 'modified' as const }] } : {}),
      };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
      logger.error({ inputPath, err: msg }, 'docx.replace_text error');
      return { success: false, output: `docx.replace_text error: ${msg}` };
    } finally {
      if (mapFile) await rm(mapFile, { force: true }).catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------
// docx.patch
// ---------------------------------------------------------------------------

export const docxPatchTool: ToolDefinition = {
  name: 'docx.patch',
  description:
    'Apply a batch of structured operations to an existing .docx via a JSON patch array (grok ' +
    'docx_patch schema). Set `dryRun` to preview. Writes to `outputPath` or overwrites the input. ' +
    'Paths under /tmp/ or data/docx/.',
  category: 'content',
  timeout: 40_000,
  parameters: {
    inputPath: { type: 'string', required: true, description: 'Existing .docx to patch.' },
    patch: { type: 'array', required: true, description: 'Array of patch operations (docx_patch schema).' },
    outputPath: { type: 'string', required: false, description: 'Where to write (.docx). Omit to overwrite the input.' },
    allFiles: { type: 'boolean', required: false, description: 'Also patch headers/footers.' },
    dryRun: { type: 'boolean', required: false, description: 'Preview changes without writing.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const inputPath = String(args['inputPath'] ?? '');
    const invalid = await validateInput(inputPath);
    if (invalid) return { success: false, output: `docx.patch error: ${invalid}` };
    if (!Array.isArray(args['patch']) || args['patch'].length === 0) {
      return { success: false, output: 'docx.patch error: `patch` must be a non-empty array of operations' };
    }

    const out = resolveOutput(inputPath, args);
    if ('error' in out) return { success: false, output: `docx.patch error: ${out.error}` };
    const dryRun = args['dryRun'] === true;
    if (!dryRun && !(await isRealPathAllowed(out.outputPath, 'output'))) {
      return { success: false, output: `docx.patch error: outputPath resolves outside allowed dirs: ${out.outputPath}` };
    }

    let patchFile: string | undefined;
    try {
      patchFile = path.join(os.tmpdir(), `docxpatch-${process.pid}-${Date.now()}.json`);
      await writeFile(patchFile, JSON.stringify(args['patch']), 'utf8');
      const editArgs = ['--patch-file', patchFile];
      if (args['allFiles'] === true) editArgs.push('--all-files');

      const script = path.join(SCRIPTS, 'docx_patch.py');
      const r = await unpackEditPack(inputPath, out.outputPath, script, editArgs, dryRun);
      logger.info({ inputPath, outputPath: r.outputPath, ops: (args['patch'] as unknown[]).length, dryRun }, 'docx.patch ok');
      return {
        success: true,
        output: (dryRun ? '[dry-run] ' : '') + (r.output || 'done'),
        data: { inputPath, outputPath: r.outputPath, dryRun },
        ...(r.outputPath ? { artifacts: [{ path: r.outputPath, action: 'modified' as const }] } : {}),
      };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
      logger.error({ inputPath, err: msg }, 'docx.patch error');
      return { success: false, output: `docx.patch error: ${msg}` };
    } finally {
      if (patchFile) await rm(patchFile, { force: true }).catch(() => {});
    }
  },
};

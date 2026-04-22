/**
 * coder.write-file — Create or overwrite a file.
 * Auto-creates parent directories (mkdir -p semantics).
 * Optionally backs up the existing file before overwriting.
 */

import { writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const writeFileTool: ToolDefinition = {
  name: 'coder.write-file',
  description:
    'Create or overwrite a file with given content. ' +
    'Automatically creates any missing parent directories. ' +
    'Optionally creates a .bak backup before overwriting an existing file.',
  category: 'coder',
  requiresConfirmation: false,
  timeout: 15_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'Absolute or working-dir-relative path to the file to write.',
    },
    content: {
      type: 'string',
      required: true,
      description: 'Full text content to write to the file.',
    },
    createBackup: {
      type: 'boolean',
      required: false,
      default: false,
      description: 'If true and the file already exists, save a .bak copy before overwriting.',
    },
    encoding: {
      type: 'string',
      required: false,
      default: 'utf-8',
      description: "File encoding. Defaults to 'utf-8'.",
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const rawPath = params['path'];
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return { success: false, output: 'coder.write-file: "path" parameter is required.' };
    }
    if (typeof params['content'] !== 'string') {
      return { success: false, output: 'coder.write-file: "content" parameter is required.' };
    }

    const filePath = resolve(ctx.workingDir, rawPath);
    if (!filePath.startsWith(ctx.workingDir)) {
      return { success: false, output: `Path traversal blocked: ${rawPath} resolves outside working directory` };
    }
    const content = params['content'] as string;
    const createBackup = params['createBackup'] === true;
    const encoding = typeof params['encoding'] === 'string' ? params['encoding'] : 'utf-8';

    try {
      // Ensure parent directories exist.
      await mkdir(dirname(filePath), { recursive: true });

      let backedUp = false;
      let backupPath: string | undefined;

      if (createBackup && (await fileExists(filePath))) {
        backupPath = `${filePath}.bak`;
        await copyFile(filePath, backupPath);
        backedUp = true;
        log.info({ tool: 'coder.write-file', backupPath }, 'Backup created');
      }

      await writeFile(filePath, content, { encoding: encoding as BufferEncoding });
      const bytesWritten = Buffer.byteLength(content, encoding as BufferEncoding);

      log.info({ tool: 'coder.write-file', path: filePath, bytesWritten }, 'File written');

      const artifacts = [{ path: filePath, action: 'created' as const, size: bytesWritten }];
      if (backedUp && backupPath) {
        artifacts.push({ path: backupPath, action: 'created' as const, size: bytesWritten });
      }

      const backupNote = backedUp ? ` (backup saved to ${backupPath})` : '';
      return {
        success: true,
        output: `Written ${bytesWritten} bytes to ${filePath}${backupNote}`,
        data: { path: filePath, bytesWritten, backedUp, backupPath },
        artifacts,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: 'coder.write-file', path: filePath, err }, 'Failed to write file');
      return { success: false, output: `coder.write-file error: ${msg}` };
    }
  },
};

export default writeFileTool;

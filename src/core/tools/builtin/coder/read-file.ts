/**
 * coder.read-file — Read any file with line numbers (cat -n style).
 * Handles large files via offset/limit, detects binary files,
 * and respects AbortSignal for cancellation.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

// ESM-safe __dirname replacement. tsx (Node's --loader) runs source as ESM,
// where the CommonJS-only `__dirname` global is undefined and reading it
// throws ReferenceError. fileURLToPath(import.meta.url) is the standard
// portable replacement.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Binary file extensions — return metadata instead of raw bytes.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.db', '.sqlite', '.bin',
]);

function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n');
  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(6, ' ');
      return `${lineNum}\t${line}`;
    })
    .join('\n');
}

export const readFileTool: ToolDefinition = {
  name: 'coder.read-file',
  description:
    'Read any file from the filesystem with line numbers. Supports offset/limit for large files. ' +
    'Automatically detects and reports binary files without dumping raw bytes.',
  category: 'coder',
  timeout: 15_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'Absolute or working-dir-relative path to the file.',
    },
    offset: {
      type: 'number',
      required: false,
      default: 1,
      description: 'Line number to start reading from (1-based). Defaults to 1.',
    },
    limit: {
      type: 'number',
      required: false,
      description: 'Maximum number of lines to return. Omit to read the whole file.',
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
      return { success: false, output: 'coder.read-file: "path" parameter is required.' };
    }

    // Handle absolute vs relative paths:
    // - Absolute paths (starting with /) are resolved as-is
    // - Relative paths are resolved against ctx.workingDir (workspace session dir)
    const filePath = rawPath.startsWith('/') ? rawPath : resolve(ctx.workingDir, rawPath);

    // Path traversal guard: only block if trying to escape project root
    const projectRoot = resolve(__dirname, '../../../../');
    if (!filePath.startsWith(projectRoot)) {
      return { success: false, output: `Path traversal blocked: ${rawPath} resolves outside project root` };
    }

    const offset = typeof params['offset'] === 'number' ? Math.max(1, params['offset']) : 1;
    const limit = typeof params['limit'] === 'number' ? Math.max(1, params['limit']) : undefined;
    const encoding = typeof params['encoding'] === 'string' ? params['encoding'] : 'utf-8';

    try {
      let stats;
      let actualFilePath = filePath;

      // Try the requested path first
      try {
        stats = await stat(filePath, { signal: ctx.signal } as Parameters<typeof stat>[1]);
      } catch (err: unknown) {
        // If ENOENT and path is in workspace sessions dir, try fallback to project root
        const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
        const isWorkspacePath = filePath.includes('/workspace/sessions/');

        if (isEnoent && isWorkspacePath) {
          // Fallback: try resolving against project root instead of workspace
          const fallbackPath = rawPath.startsWith('/') ? rawPath : resolve(projectRoot, rawPath);
          try {
            stats = await stat(fallbackPath, { signal: ctx.signal } as Parameters<typeof stat>[1]);
            actualFilePath = fallbackPath;
            log.info({ fallbackPath, originalPath: filePath }, 'read-file: workspace path not found, using project root fallback');
          } catch (fallbackErr) {
            // Both paths failed - throw original error
            throw err;
          }
        } else {
          throw err;
        }
      }

      if (!stats.isFile()) {
        return { success: false, output: `coder.read-file: "${actualFilePath}" is not a file.` };
      }

      if (isBinaryExtension(actualFilePath)) {
        const output =
          `Binary file: ${actualFilePath}\n` +
          `Size: ${stats.size} bytes\n` +
          `Extension: ${extname(actualFilePath)}\n` +
          `Modified: ${stats.mtime.toISOString()}`;
        return {
          success: true,
          output,
          data: { path: actualFilePath, binary: true, size: stats.size },
          artifacts: [{ path: actualFilePath, action: 'read', size: Number(stats.size) }],
        };
      }

      const raw = await readFile(actualFilePath, { encoding: encoding as BufferEncoding, signal: ctx.signal });
      const allLines = raw.split('\n');
      const totalLines = allLines.length;

      const startIdx = offset - 1; // convert 1-based to 0-based
      const endIdx = limit !== undefined ? startIdx + limit : totalLines;
      const slicedLines = allLines.slice(startIdx, endIdx);

      const numbered = addLineNumbers(slicedLines.join('\n'), offset);
      const truncated = endIdx < totalLines;
      const header = `File: ${actualFilePath} (${totalLines} lines total)`;
      const footer = truncated
        ? `\n[Showing lines ${offset}–${offset + slicedLines.length - 1} of ${totalLines}. Use offset/limit to read more.]`
        : '';

      log.info({ tool: 'coder.read-file', path: actualFilePath, lines: slicedLines.length }, 'File read');

      return {
        success: true,
        output: `${header}\n${'─'.repeat(60)}\n${numbered}${footer}`,
        data: { path: filePath, totalLines, offset, linesReturned: slicedLines.length, truncated },
        artifacts: [{ path: filePath, action: 'read', size: Number(stats.size) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: 'coder.read-file', path: filePath, err }, 'Failed to read file');
      return { success: false, output: `coder.read-file error: ${msg}` };
    }
  },
};

export default readFileTool;

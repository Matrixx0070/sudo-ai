/**
 * super.archive — Compress, extract, or list archive files.
 *
 * Supports zip, tar.gz, and tar.bz2 formats via execFile (no shell injection).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../tools/types.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('super.archive');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Format = 'zip' | 'tar.gz' | 'tar.bz2';

interface RunOpts { signal?: AbortSignal; cwd?: string }

async function run(bin: string, args: string[], opts: RunOpts = {}): Promise<string> {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    signal: opts.signal,
    cwd: opts.cwd,
    maxBuffer: 16 * 1024 * 1024,
  }).catch((err: unknown) => {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const details = (e.stderr ?? e.stdout ?? String(err)).slice(-2000);
    throw new Error(`${bin} exited with code ${e.code ?? 1}: ${details}`);
  });
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

function detectFormat(archivePath: string): Format {
  if (archivePath.endsWith('.zip')) return 'zip';
  if (archivePath.endsWith('.tar.bz2') || archivePath.endsWith('.tbz2')) return 'tar.bz2';
  return 'tar.gz';
}

async function compressArchive(
  input: string,
  output: string,
  format: Format,
  signal?: AbortSignal,
): Promise<string> {
  switch (format) {
    case 'zip':
      return run('zip', ['-r', output, input], { signal });
    case 'tar.gz':
      return run('tar', ['-czf', output, input], { signal });
    case 'tar.bz2':
      return run('tar', ['-cjf', output, input], { signal });
  }
}

async function extractArchive(
  input: string,
  output: string,
  format: Format,
  signal?: AbortSignal,
): Promise<string> {
  switch (format) {
    case 'zip':
      return run('unzip', ['-o', input, '-d', output], { signal });
    case 'tar.gz':
      return run('tar', ['-xzf', input, '-C', output], { signal });
    case 'tar.bz2':
      return run('tar', ['-xjf', input, '-C', output], { signal });
  }
}

async function listArchive(input: string, format: Format, signal?: AbortSignal): Promise<string> {
  switch (format) {
    case 'zip':
      return run('unzip', ['-l', input], { signal });
    case 'tar.gz':
      return run('tar', ['-tzf', input], { signal });
    case 'tar.bz2':
      return run('tar', ['-tjf', input], { signal });
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const archiveManagerTool: ToolDefinition = {
  name: 'super.archive',
  description: 'Compress, extract, or list archive files in zip, tar.gz, or tar.bz2 format.',
  category: 'superpowers',
  timeout: 120_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'Archive operation to perform.',
      required: true,
      enum: ['compress', 'extract', 'list'],
    },
    input: {
      type: 'string',
      description: 'Source path: directory/file to compress, or archive to extract/list.',
      required: true,
    },
    output: {
      type: 'string',
      description: 'Destination: archive file path (compress) or directory (extract). Not required for list.',
    },
    format: {
      type: 'string',
      description: 'Archive format. Auto-detected from extension when omitted.',
      enum: ['zip', 'tar.gz', 'tar.bz2'],
      default: 'tar.gz',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = params['operation'] as string | undefined;
    const input = params['input'] as string | undefined;
    const output = params['output'] as string | undefined;
    const formatParam = params['format'] as string | undefined;

    if (!operation) return { success: false, output: 'operation is required.' };
    if (!input) return { success: false, output: 'input is required.' };
    if ((operation === 'compress' || operation === 'extract') && !output) {
      return { success: false, output: `output is required for ${operation}.` };
    }

    // For compress, the archive path is `output`; for extract/list it is `input`.
    const formatSource = operation === 'compress' ? (output ?? input) : input;
    const format: Format = (formatParam as Format | undefined) ?? detectFormat(formatSource);

    logger.info({ session: ctx.sessionId, operation, input, output, format }, 'Archive operation started');

    try {
      let result: string;

      switch (operation) {
        case 'compress': {
          result = await compressArchive(input, output!, format, ctx.signal);
          logger.info({ input, output, format }, 'Archive compressed');
          const artifacts: ToolArtifact[] = [{ path: output!, action: 'created' }];
          return { success: true, output: `Compressed "${input}" → ${output}\n${result}`, data: { operation, input, output, format }, artifacts };
        }

        case 'extract': {
          result = await extractArchive(input, output!, format, ctx.signal);
          logger.info({ input, output, format }, 'Archive extracted');
          const artifacts: ToolArtifact[] = [{ path: output!, action: 'created' }];
          return { success: true, output: `Extracted "${input}" → ${output}\n${result}`, data: { operation, input, output, format }, artifacts };
        }

        case 'list': {
          result = await listArchive(input, format, ctx.signal);
          logger.info({ input, format }, 'Archive listed');
          return { success: true, output: `Contents of "${input}":\n${result}`, data: { operation, input, format, listing: result } };
        }

        default:
          return { success: false, output: `Unknown operation: ${operation}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ operation, input, err: msg }, 'Archive operation failed');
      return { success: false, output: `Archive operation failed: ${msg}` };
    }
  },
};

/**
 * @file grok-files.ts
 * @description `sudo-ai grok files <upload|info|download>` — persistent file
 * upload + management on the FREE $30 subscription seat (app-chat file lane).
 * The returned fileMetadataId is reusable across chats (grok rag consumes it).
 * The seat exposes no list/delete — only upload, info, download exist.
 *
 * NOTE: registered into the `grok` command group via one registerGrokFiles()
 * call in src/cli/index.ts. No provider URL literal lives here (choke-point guard).
 */
import type { Command } from 'commander';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

/**
 * Reduce a server-supplied file name to a safe basename in the current
 * directory — the download metadata's `fileName` is untrusted remote data, so a
 * crafted `../../etc/x` or absolute path must never steer the write location.
 */
function safeDownloadName(fileName: string | undefined, fallback: string): string {
  const base = fileName ? path.basename(fileName) : '';
  return !base || base === '.' || base === '..' ? fallback : base;
}

function printError(prefix: string, err: unknown): void {
  const cls = (err as { errorClass?: string })?.errorClass;
  console.error(
    `${prefix} failed${cls ? ` [${cls}]` : ''}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Run `sudo-ai grok files upload <path>`. Returns a process exit code. */
export async function runGrokFilesUpload(filePath: string, opts: { mime?: string }): Promise<number> {
  const { uploadGrokFile } = await import('../../llm/grok-files.js');
  try {
    const file = await uploadGrokFile(filePath, opts.mime ? { mimeType: opts.mime } : {});
    process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
    return 0;
  } catch (err) {
    printError('grok files upload', err);
    return 2;
  }
}

/** Run `sudo-ai grok files info <fileMetadataId>`. */
export async function runGrokFilesInfo(fileMetadataId: string): Promise<number> {
  const { getGrokFileMetadata } = await import('../../llm/grok-files.js');
  try {
    const file = await getGrokFileMetadata(fileMetadataId);
    process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
    return 0;
  } catch (err) {
    printError('grok files info', err);
    return 2;
  }
}

/** Run `sudo-ai grok files download <fileMetadataId> --out <path>`. */
export async function runGrokFilesDownload(
  fileMetadataId: string,
  opts: { out?: string },
): Promise<number> {
  const { downloadGrokFile } = await import('../../llm/grok-files.js');
  try {
    const { file, content } = await downloadGrokFile(fileMetadataId);
    // Owner-supplied --out is honoured verbatim (explicit intent). Without it,
    // fall back to a SANITISED basename of the server's fileName in cwd — never
    // let untrusted remote metadata traverse out of the working directory.
    const out = opts.out
      ? path.resolve(opts.out)
      : path.resolve(process.cwd(), safeDownloadName(file.fileName, `${fileMetadataId}.bin`));
    await writeFile(out, content);
    process.stdout.write(`wrote ${content.length} bytes -> ${out}\n`);
    return 0;
  } catch (err) {
    printError('grok files download', err);
    return 2;
  }
}

/** Register `grok files` on the grok command group (one call from src/cli/index.ts). */
export function registerGrokFiles(grokCmd: Command): void {
  const files = grokCmd
    .command('files')
    .description('Persistent file storage on your FREE seat: upload/info/download. Ids are reusable across chats (grok rag). No list/delete exists on the seat. Needs SUDO_GROK_WEBSESSION=1.');
  files
    .command('upload <path>')
    .description('Upload a local file; prints the stored metadata incl. fileMetadataId')
    .option('--mime <type>', 'MIME type override (default from extension)')
    .action(async (p: string, opts: { mime?: string }) => process.exit(await runGrokFilesUpload(p, opts)));
  files
    .command('info <fileMetadataId>')
    .description('Fetch stored metadata for an uploaded file')
    .action(async (id: string) => process.exit(await runGrokFilesInfo(id)));
  files
    .command('download <fileMetadataId>')
    .description('Download an uploaded file back to disk')
    .option('--out <path>', 'Output path (default: original file name in cwd)')
    .action(async (id: string, opts: { out?: string }) => process.exit(await runGrokFilesDownload(id, opts)));
}

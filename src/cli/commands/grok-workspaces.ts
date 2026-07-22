/**
 * @file grok-workspaces.ts
 * @description `sudo-ai grok workspaces <list|info|files|download>` — READ-ONLY
 * workspace access on the FREE $30 subscription seat (cookie lane,
 * statsig-free): list owned/shared workspaces, inspect one (incl. computer-root
 * access state, connectors, collections, permissions), list its files and
 * download a file. V1 wires no write op (no create/upload/delete).
 *
 * NOTE: registered into the `grok` command group via one registerGrokWorkspaces()
 * call in src/cli/index.ts. No provider URL literal lives here (choke-point guard).
 */
import type { Command } from 'commander';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

/**
 * Reduce a server-supplied remote path to a safe basename in the current
 * directory — remote names are untrusted data, so a crafted `../../etc/x` or
 * absolute path must never steer the write location.
 */
function safeDownloadName(remotePath: string | undefined, fallback: string): string {
  const base = remotePath ? path.basename(remotePath.replaceAll('\\', '/')) : '';
  return !base || base === '.' || base === '..' ? fallback : base;
}

function printError(prefix: string, err: unknown): void {
  const cls = (err as { errorClass?: string })?.errorClass;
  console.error(
    `${prefix} failed${cls ? ` [${cls}]` : ''}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Run `sudo-ai grok workspaces list`. Returns a process exit code. */
export async function runGrokWorkspacesList(opts: { shared?: boolean }): Promise<number> {
  const { listGrokWorkspaces } = await import('../../llm/grok-workspaces.js');
  try {
    const r = await listGrokWorkspaces(opts.shared ? { shared: true } : {});
    if (r.workspaces.length === 0) {
      console.log(opts.shared ? '(no workspaces shared with you)' : '(no workspaces on this seat)');
      return 0;
    }
    process.stdout.write(`${JSON.stringify(r.workspaces, null, 2)}\n`);
    return 0;
  } catch (err) {
    printError('grok workspaces list', err);
    return 2;
  }
}

/** Run `sudo-ai grok workspaces info <workspaceId>`. */
export async function runGrokWorkspacesInfo(workspaceId: string): Promise<number> {
  const { getGrokWorkspace } = await import('../../llm/grok-workspaces.js');
  try {
    const detail = await getGrokWorkspace(workspaceId);
    process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
    return 0;
  } catch (err) {
    printError('grok workspaces info', err);
    return 2;
  }
}

/** Run `sudo-ai grok workspaces files <workspaceId>`. */
export async function runGrokWorkspacesFiles(
  workspaceId: string,
  opts: { path?: string; recursive?: boolean },
): Promise<number> {
  const { listGrokWorkspaceFiles } = await import('../../llm/grok-workspaces.js');
  try {
    const r = await listGrokWorkspaceFiles(workspaceId, opts);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  } catch (err) {
    printError('grok workspaces files', err);
    return 2;
  }
}

/** Run `sudo-ai grok workspaces download <workspaceId> <remotePath> [--out]`. */
export async function runGrokWorkspacesDownload(
  workspaceId: string,
  remotePath: string,
  opts: { out?: string },
): Promise<number> {
  const { downloadGrokWorkspaceFile } = await import('../../llm/grok-workspaces.js');
  try {
    const { content } = await downloadGrokWorkspaceFile(workspaceId, remotePath);
    // Owner-supplied --out is honoured verbatim (explicit intent). Without it,
    // fall back to a SANITISED basename of the remote path in cwd — never let
    // untrusted remote data traverse out of the working directory.
    const out = opts.out
      ? path.resolve(opts.out)
      : path.resolve(process.cwd(), safeDownloadName(remotePath, 'workspace-file.bin'));
    await writeFile(out, content);
    process.stdout.write(`wrote ${content.length} bytes -> ${out}\n`);
    return 0;
  } catch (err) {
    printError('grok workspaces download', err);
    return 2;
  }
}

/** Register `grok workspaces` on the grok command group (one call from src/cli/index.ts). */
export function registerGrokWorkspaces(grokCmd: Command): void {
  const ws = grokCmd
    .command('workspaces')
    .description('READ-ONLY workspace access on your FREE seat: list/info/files/download (incl. computer-root access state). Needs SUDO_GROK_WEBSESSION=1.');
  ws
    .command('list')
    .description('List workspaces on the seat')
    .option('--shared', 'List workspaces shared with you instead')
    .action(async (opts: { shared?: boolean }) => process.exit(await runGrokWorkspacesList(opts)));
  ws
    .command('info <workspaceId>')
    .description('One workspace + computer-root access, connectors, collections, permissions')
    .action(async (id: string) => process.exit(await runGrokWorkspacesInfo(id)));
  ws
    .command('files <workspaceId>')
    .description("List a workspace's files")
    .option('--path <p>', 'List under this workspace-relative path')
    .option('--recursive', 'Recurse into folders')
    .action(async (id: string, opts: { path?: string; recursive?: boolean }) =>
      process.exit(await runGrokWorkspacesFiles(id, opts)));
  ws
    .command('download <workspaceId> <remotePath>')
    .description('Download one workspace file to disk')
    .option('--out <path>', 'Output path (default: sanitised remote basename in cwd)')
    .action(async (id: string, rp: string, opts: { out?: string }) =>
      process.exit(await runGrokWorkspacesDownload(id, rp, opts)));
}

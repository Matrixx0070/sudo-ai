/**
 * @file grok-runcode.ts
 * @description `sudo-ai grok run-code` — execute a snippet in grok's
 * server-side code interpreter, free on the $30 subscription seat, and print
 * the executed stdout/stderr. Reads code from `--code`, `--file`, or stdin.
 *
 * NOTE: registration into the `grok` command group in src/cli/index.ts is
 * wired by the supervisor (kept out of this file to avoid sibling conflicts).
 */
import { readFile } from 'node:fs/promises';

export interface GrokRunCodeCliOptions {
  /** Inline code snippet. */
  code?: string;
  /** Path to a file containing the code (used when --code is absent). */
  file?: string;
  /** Interpreter language hint; defaults to python (the verified language). */
  lang?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Run `sudo-ai grok run-code`. Returns a process exit code. */
export async function runGrokRunCode(opts: GrokRunCodeCliOptions): Promise<number> {
  let code = opts.code;
  if (code === undefined && opts.file !== undefined) {
    try {
      code = await readFile(opts.file, 'utf8');
    } catch (err) {
      console.error(
        `Cannot read code file "${opts.file}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return 2;
    }
  }
  if (code === undefined) {
    if (process.stdin.isTTY) {
      console.error('Provide code via --code, --file, or piped stdin.');
      return 2;
    }
    code = await readStdin();
  }
  if (code.trim() === '') {
    console.error('Code is empty.');
    return 2;
  }

  const { runGrokCode, GrokRunCodeError } = await import('../../llm/grok-runcode.js');
  let result;
  try {
    result = await runGrokCode(opts.lang ?? 'python', code);
  } catch (err) {
    if (err instanceof GrokRunCodeError) {
      console.error(`grok run-code failed [${err.errorClass}]: ${err.message}`);
    } else {
      console.error(`grok run-code failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 2;
  }

  if (result.stdout !== '') process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr !== '') process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  // 0 = clean run; 1 = the executed code produced stderr (error/traceback).
  return result.stderr.trim() === '' ? 0 : 1;
}

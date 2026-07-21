/**
 * @file grok-rag.ts
 * @description `sudo-ai grok rag --file <path> --ask '<question>'` — ask a
 * question grounded in one or more uploaded documents, FREE on the $30
 * subscription seat (app-chat file-attach lane). Repeatable --file; or --text.
 *
 * NOTE: registered into the `grok` command group via one registerGrokRag()
 * call in src/cli/index.ts. No provider URL literal lives here (choke-point guard).
 */
import type { Command } from 'commander';

export interface GrokRagCliOptions {
  /** Repeatable local file path(s) to attach. */
  file?: string[];
  /** Repeatable inline text document(s). */
  text?: string[];
  /** The grounded question. */
  ask?: string;
  /** Optional answering-model override. */
  model?: string;
}

/** Run `sudo-ai grok rag`. Returns a process exit code. */
export async function runGrokRag(opts: GrokRagCliOptions): Promise<number> {
  const question = (opts.ask ?? '').trim();
  if (question === '') {
    console.error("Provide a question with --ask '<question>'.");
    return 2;
  }
  const files = opts.file ?? [];
  const texts = opts.text ?? [];
  if (files.length === 0 && texts.length === 0) {
    console.error('Provide at least one --file <path> or --text <content>.');
    return 2;
  }

  const { grokRagQuery, GrokRagError } = await import('../../llm/grok-rag.js');
  try {
    const result = await grokRagQuery({
      question,
      files,
      texts,
      ...(opts.model ? { modelName: opts.model } : {}),
    });
    process.stdout.write(result.answer.endsWith('\n') ? result.answer : `${result.answer}\n`);
    return 0;
  } catch (err) {
    if (err instanceof GrokRagError) {
      console.error(`grok rag failed [${err.errorClass}]: ${err.message}`);
    } else {
      console.error(`grok rag failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 2;
  }
}

/** Register `grok rag` on the grok command group (one call from src/cli/index.ts). */
export function registerGrokRag(grokCmd: Command): void {
  const collect = (v: string, a: string[]): string[] => a.concat(v);
  grokCmd
    .command('rag')
    .description('Ask a question grounded in uploaded documents, FREE on your seat (app-chat file-attach lane). Needs SUDO_GROK_WEBSESSION=1.')
    .option('--file <path>', 'Document to attach (repeatable)', collect, [] as string[])
    .option('--text <content>', 'Inline text document (repeatable)', collect, [] as string[])
    .option('--ask <question>', 'The grounded question')
    .option('--model <model>', 'Answering model override')
    .action(async (opts: GrokRagCliOptions) => process.exit(await runGrokRag(opts)));
}

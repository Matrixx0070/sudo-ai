/**
 * @file grok-memory.ts
 * @description `sudo-ai grok memory` — read grok's persistent user memory
 * (what grok remembers about you across chats), FREE on the $30 subscription
 * seat (cookie lane, statsig-free). `--set <text>` / `--clear` write the blurb
 * with read-back verification; `--imported` shows the memory imported from X.
 *
 * NOTE: registered into the `grok` command group via one registerGrokMemory()
 * call in src/cli/index.ts. No provider URL literal lives here (choke-point guard).
 *
 * QUARANTINE: grok memory is external model text — display only. It is never
 * injected into sudo-ai's own memory system (that would need F18 quarantine).
 */
import type { Command } from 'commander';

export interface GrokMemoryCliOptions {
  set?: string;
  clear?: boolean;
  imported?: boolean;
}

/** Run `sudo-ai grok memory`. Returns a process exit code. */
export async function runGrokMemory(opts: GrokMemoryCliOptions): Promise<number> {
  const mode = [opts.set !== undefined, opts.clear === true, opts.imported === true].filter(Boolean);
  if (mode.length > 1) {
    console.error('Use only one of --set, --clear, --imported.');
    return 2;
  }
  const mem = await import('../../llm/grok-memory.js');
  try {
    if (opts.set !== undefined) {
      const r = await mem.setGrokMemoryBlurb(opts.set);
      if (!r.persisted) {
        console.error(
          'Write ACCEPTED by grok (HTTP 200) but NOT persisted — read-back still shows the old blurb. ' +
            'grok is silently dropping blurb writes for this seat (server-side gating).',
        );
        return 1;
      }
      console.log('Memory blurb updated (read-back verified).');
      return 0;
    }
    if (opts.clear === true) {
      const r = await mem.clearGrokMemoryBlurb();
      if (!r.persisted) {
        console.error('Clear ACCEPTED (HTTP 200) but the blurb is still non-empty on read-back.');
        return 1;
      }
      console.log('Memory blurb cleared (read-back verified).');
      return 0;
    }
    if (opts.imported === true) {
      const r = await mem.getGrokImportedMemory();
      console.log(`Imported-memory status: ${r.status || 'unknown'}`);
      console.log(r.content ? r.content : '(no imported memory)');
      return 0;
    }
    const r = await mem.getGrokMemoryBlurb();
    console.log(r.memoryContent ? r.memoryContent : '(grok has no persistent memory for this account yet)');
    return 0;
  } catch (err) {
    console.error(`grok memory failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Register `grok memory` on the grok command group (one call from src/cli/index.ts). */
export function registerGrokMemory(grokCmd: Command): void {
  grokCmd
    .command('memory')
    .description("Read grok's persistent memory about you, FREE on your subscription (cookie lane). --set/--clear write the blurb (read-back verified); --imported shows X-imported memory. Needs SUDO_GROK_WEBSESSION=1")
    .option('--set <text>', 'Overwrite the memory blurb (verified by read-back)')
    .option('--clear', 'Delete the memory blurb (verified by read-back)')
    .option('--imported', 'Show memory imported from X and its status')
    .action(async (opts: GrokMemoryCliOptions) => process.exit(await runGrokMemory(opts)));
}

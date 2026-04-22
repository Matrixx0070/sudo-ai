/**
 * @file builtin/learn.ts
 * @description /learn — display recent learnings from the WisdomStore / learning store.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:learn');

interface LearningEntry {
  insight: string;
  confidence?: number;
  createdAt?: string | Date;
  source?: string;
}

interface WisdomStore {
  listRecent?: (limit: number) => LearningEntry[];
  getAll?: () => LearningEntry[];
}

export const learnCommand: SlashCommand = {
  name: 'learn',
  description: 'Show recent learnings from the WisdomStore.',
  usage: '/learn',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId }, '/learn executed');

    const config = ctx.config as { wisdomStore?: WisdomStore; learningStore?: WisdomStore } | null;
    const store: WisdomStore | undefined = config?.wisdomStore ?? config?.learningStore;

    let entries: LearningEntry[] = [];

    if (store) {
      try {
        entries = store.listRecent?.(10) ?? store.getAll?.()?.slice(-10) ?? [];
      } catch (err) {
        log.error({ err }, 'Failed to read from WisdomStore');
        return `Failed to read learnings: ${String(err)}`;
      }
    } else {
      // Fallback: read from DB if learning_store table or chunks exist
      const db = ctx.db as {
        db?: { prepare: (q: string) => { all: () => Array<{ text: string }> } };
      } | null;

      try {
        const rows = db?.db?.prepare(
          `SELECT text FROM chunks WHERE source = 'learning' ORDER BY rowid DESC LIMIT 10`,
        ).all();

        if (rows && rows.length > 0) {
          entries = rows.map((r) => ({ insight: r.text }));
        }
      } catch {
        // non-fatal
      }
    }

    if (entries.length === 0) {
      return 'No learnings recorded yet.';
    }

    const lines = ['Recent learnings:', ''];
    entries.forEach((e, i) => {
      const conf = e.confidence != null ? ` (confidence: ${(e.confidence * 100).toFixed(0)}%)` : '';
      lines.push(`${i + 1}. ${e.insight}${conf}`);
    });

    log.info({ count: entries.length }, '/learn returned results');
    return lines.join('\n');
  },
};

/**
 * @file memory-consolidate.ts
 * @description `meta.memory-consolidate` (gap #20) — explicit on-demand
 * trigger for the LLM-written MEMORY.md curator pass.
 *
 * The agent (or operator via the registry) calls this when MEMORY.md has
 * grown enough that an organized rewrite is worth the LLM round-trip. The
 * heavy lifting lives in `core/memory/memory-consolidator.ts`; this tool
 * is a thin parameter-resolution + report-formatting wrapper.
 *
 * Default path: `<workspace>/MEMORY.md` (matches `AutoDream._promoteToMemoryMd`).
 * Caller may override via the `memoryPath` parameter for tests / scripted
 * usage against a different file.
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { PATHS } from '../../../shared/constants.js';
import {
  consolidateMemoryFile,
  shouldConsolidate,
  type ConsolidatorBrain,
} from '../../../memory/memory-consolidator.js';

const logger = createLogger('meta.memory-consolidate');

interface ConfigLike { brain?: ConsolidatorBrain }

export const memoryConsolidateTool: ToolDefinition = {
  name: 'meta.memory-consolidate',
  description:
    'Rewrite MEMORY.md via an LLM curator pass: dedupe, group by theme, drop noise — ' +
    'preserving every load-bearing fact. The original is backed up before any overwrite ' +
    '(see `.memory-backups/MEMORY.<ISO>.md`). Use when MEMORY.md has grown enough that an ' +
    'organized rewrite is worth the cost; the heuristic `shouldConsolidate` checks the file ' +
    'is at least ~8 KB by default.',
  category: 'meta' as const,
  safety: 'destructive', // it overwrites a file the operator may want to inspect
  requiresConfirmation: true,
  timeout: 60_000,
  parameters: {
    memoryPath: {
      type: 'string',
      description:
        'Absolute path to MEMORY.md. Defaults to <workspace>/MEMORY.md (the same path AutoDream writes to).',
    },
    backupDir: {
      type: 'string',
      description:
        'Where to write the pre-rewrite backup. Defaults to a `.memory-backups/` subdirectory next to memoryPath.',
    },
    model: {
      type: 'string',
      description: 'Optional brain model override for the curator pass.',
    },
    force: {
      type: 'boolean',
      description: 'Skip the shouldConsolidate size-threshold heuristic and run the pass unconditionally.',
      default: false,
    },
    minBytes: {
      type: 'number',
      description: 'Threshold passed to shouldConsolidate (default 8192).',
      default: 8192,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const config = ctx.config as ConfigLike | undefined;
    const brain = config?.brain;
    if (!brain || typeof brain.call !== 'function') {
      return {
        success: false,
        output: 'meta.memory-consolidate: brain is not available on ctx.config — wiring missing.',
      };
    }

    const explicitPath = typeof params['memoryPath'] === 'string' ? (params['memoryPath'] as string) : '';
    const memoryPath = explicitPath || path.join(path.resolve(PATHS.WORKSPACE), 'MEMORY.md');
    const backupDir = typeof params['backupDir'] === 'string' && (params['backupDir'] as string).length > 0
      ? (params['backupDir'] as string)
      : undefined;
    const model = typeof params['model'] === 'string' && (params['model'] as string).length > 0
      ? (params['model'] as string)
      : undefined;
    const force = params['force'] === true;
    const minBytes = typeof params['minBytes'] === 'number' && (params['minBytes'] as number) > 0
      ? (params['minBytes'] as number)
      : 8192;

    if (!force && !shouldConsolidate(memoryPath, minBytes)) {
      return {
        success: true,
        output:
          `meta.memory-consolidate: MEMORY.md (${memoryPath}) is below the ${minBytes}-byte threshold. ` +
          `Pass force:true to run anyway.`,
        data: { skipped: true, memoryPath, minBytes },
      };
    }

    logger.info({ sessionId: ctx.sessionId, memoryPath, force, minBytes, backupDir, model }, 'consolidating MEMORY.md');
    // Verifier HIGH #1 — thread backupDir + model through so the agent-
    // facing parameters aren't silently dropped.
    const result = await consolidateMemoryFile(brain, {
      memoryPath,
      ...(backupDir !== undefined ? { backupDir } : {}),
      ...(model !== undefined ? { model } : {}),
    });

    if (!result.consolidated) {
      // Verifier MED #2 — surface backupPath in the failure output so the
      // operator knows a backup exists (and can be retried/deleted) even
      // though the rewrite did not land.
      const backupNote = result.backupPath ? ` Pre-rewrite backup at ${result.backupPath}.` : '';
      return {
        success: false,
        output:
          `meta.memory-consolidate: consolidation was NOT applied — ${result.reason ?? 'unknown'}. ` +
          `Original MEMORY.md is untouched.${backupNote}`,
        data: result,
      };
    }

    const shrinkPct = result.inputBytes > 0 ? Math.round((1 - result.outputBytes / result.inputBytes) * 100) : 0;
    return {
      success: true,
      output:
        `meta.memory-consolidate: rewrote ${memoryPath} ` +
        `(${result.inputBytes} → ${result.outputBytes} bytes, ${shrinkPct}% shrink). ` +
        `Backup at ${result.backupPath}.`,
      data: result,
    };
  },
};

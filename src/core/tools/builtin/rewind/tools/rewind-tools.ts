/**
 * @file rewind-tools.ts
 * @description rewind.list / rewind.restore — undo the file changes a turn made.
 *
 * Mirrors what Claude Code's `/rewind` gives a user: go back to how things were
 * before a tool ran. Checkpoints are captured automatically at the ToolRegistry
 * choke point; these tools expose listing and restoring them.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('rewind:tools');

export const rewindListTool: ToolDefinition = {
  name: 'rewind.list',
  description:
    'List recent rewind checkpoints for this session — each one captures the files a tool was ' +
    'about to change, newest first. Use before rewind.restore to pick a checkpoint id.',
  category: 'system',
  timeout: 10_000,
  parameters: {
    limit: { type: 'number', required: false, description: 'How many checkpoints to list (default 20).' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const limit = typeof params['limit'] === 'number' ? Math.max(1, Math.min(100, params['limit'])) : 20;
    const { listCheckpoints, checkpointDiffers } = await import('../../../../rewind/index.js');
    const rows = listCheckpoints(ctx.sessionId ?? 'unknown', limit);
    if (rows.length === 0) {
      return { success: true, output: 'No rewind checkpoints for this session yet.' };
    }
    const lines = rows.map((r) => {
      const changed = checkpointDiffers(r.id) ? 'changed since' : 'unchanged';
      return `#${r.id}  ${r.createdAt}  ${r.label}  (${r.fileCount} file(s), ${changed})`;
    });
    return {
      success: true,
      output: `${rows.length} checkpoint(s):\n${lines.join('\n')}`,
      data: { checkpoints: rows },
    };
  },
};

export const rewindRestoreTool: ToolDefinition = {
  name: 'rewind.restore',
  description:
    'Restore the files captured in a rewind checkpoint to their state before that tool ran. ' +
    'Files that did not exist beforehand are deleted. Use rewind.list first to choose an id.',
  category: 'system',
  timeout: 30_000,
  parameters: {
    checkpointId: { type: 'number', required: true, description: 'Checkpoint id from rewind.list.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const id = params['checkpointId'];
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return { success: false, output: 'checkpointId (number) is required — run rewind.list first.' };
    }
    const { getCheckpoint, restoreCheckpoint } = await import('../../../../rewind/index.js');
    const ckpt = getCheckpoint(id);
    if (!ckpt) return { success: false, output: `No checkpoint #${id}.` };
    if (ckpt.sessionId !== (ctx.sessionId ?? 'unknown')) {
      // Restoring another session's files from a chat turn would be a surprise.
      return { success: false, output: `Checkpoint #${id} belongs to another session — refusing.` };
    }

    const r = restoreCheckpoint(id);
    logger.info({ checkpoint: id, ...r }, 'rewind restore complete');
    const parts = [
      `Rewound to checkpoint #${id} (${ckpt.label}).`,
      r.restored.length > 0 ? `Restored ${r.restored.length}: ${r.restored.join(', ')}` : '',
      r.deleted.length > 0 ? `Deleted ${r.deleted.length} (did not exist before): ${r.deleted.join(', ')}` : '',
      r.skipped.length > 0 ? `Skipped ${r.skipped.length}: ${r.skipped.join(', ')}` : '',
    ].filter((x) => x !== '');
    return { success: true, output: parts.join('\n'), data: { ...r, checkpointId: id } };
  },
};

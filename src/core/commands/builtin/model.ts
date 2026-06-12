/**
 * @file builtin/model.ts
 * @description /model [name] — show current model or switch to a named model.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:model');

/** Duck-typed Brain interface (only the fields we need). */
interface BrainLike {
  currentModel?: string;
  setModel?: (model: string) => void;
  getModel?: () => string;
}

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Show the current LLM model or switch to a new one.',
  usage: '/model [name]',

  async execute(args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId, args }, '/model executed');

    const agentLoop = ctx.agentLoop as { brain?: BrainLike } | null;
    const brain: BrainLike | undefined = agentLoop?.brain;

    const target = args.trim();

    if (!target) {
      const current = brain?.getModel?.() ?? brain?.currentModel ?? 'unknown';
      return `Current model: ${current}`;
    }

    if (!brain?.setModel) {
      log.warn({ target }, 'Brain does not support runtime model switching');
      return `Model switching is not available. Requested: ${target}`;
    }

    try {
      brain.setModel(target);
      const canonical = brain.getModel?.() ?? target;
      log.info({ target, model: canonical }, 'Model switched via /model command');
      return `Model switched to: ${canonical}`;
    } catch (err) {
      log.error({ target, err }, 'Failed to switch model');
      return `Failed to switch model to "${target}": ${String(err)}`;
    }
  },
};

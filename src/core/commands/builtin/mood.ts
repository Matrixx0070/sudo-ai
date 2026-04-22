/**
 * @file builtin/mood.ts
 * @description /mood [name] — show current mood or switch to a named one.
 */

import { createLogger } from '../../shared/index.js';
import { listMoods } from '../../brain/moods.js';
import type { SlashCommand, CommandContext } from '../types.js';
import type { MoodType } from '../../brain/types.js';

const log = createLogger('commands:mood');

const VALID_MOODS = new Set<string>(listMoods().map((m) => m.type));

interface BrainLike {
  currentMood?: string;
  getMood?: () => string;
  setMood?: (mood: MoodType) => void;
}

export const moodCommand: SlashCommand = {
  name: 'mood',
  description: 'Show the current mood or switch to a named one.',
  usage: '/mood [name]',

  async execute(args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId, args }, '/mood executed');

    const agentLoop = ctx.agentLoop as { brain?: BrainLike } | null;
    const brain: BrainLike | undefined = agentLoop?.brain;
    const target = args.trim().toLowerCase();

    if (!target) {
      const current = brain?.getMood?.() ?? brain?.currentMood ?? 'unknown';
      const available = listMoods().map((m) => m.type).join(', ');
      return `Current mood: ${current}\nAvailable: ${available}`;
    }

    if (!VALID_MOODS.has(target)) {
      const available = listMoods().map((m) => m.type).join(', ');
      return `Unknown mood: "${target}"\nAvailable: ${available}`;
    }

    if (!brain?.setMood) {
      return `Mood switching not available. Requested: ${target}`;
    }

    try {
      brain.setMood(target as MoodType);
      log.info({ target }, 'Mood switched via /mood command');
      return `Mood switched to: ${target}`;
    } catch (err) {
      log.error({ target, err }, 'Failed to switch mood');
      return `Failed to switch mood to "${target}": ${String(err)}`;
    }
  },
};

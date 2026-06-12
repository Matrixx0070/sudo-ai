/**
 * @file builtin/produce.ts
 * @description /produce [topic] — triggers the video pipeline for a given topic.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:produce');

export const produceCommand: SlashCommand = {
  name: 'produce',
  description: 'Trigger the video pipeline for a topic.',
  usage: '/produce [topic]',

  async execute(args: string, ctx: CommandContext): Promise<string> {
    const topic = args.trim();

    if (!topic) {
      return 'Usage: /produce [topic]\nExample: /produce AI vs humans 2026';
    }

    log.warn({ peerId: ctx.peerId, topic }, '/produce triggered, but no video pipeline is wired');
    return `Video pipeline is not available (no pipeline.start tool registered). Nothing was queued. Use the media tools instead, e.g. media.shorts-factory.`;
  },
};

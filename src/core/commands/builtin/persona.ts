/**
 * @file builtin/persona.ts
 * @description /persona [name] — show current persona or switch to a named one.
 */

import { createLogger } from '../../shared/index.js';
import { listPersonas } from '../../brain/personas.js';
import type { SlashCommand, CommandContext } from '../types.js';
import type { PersonaType } from '../../brain/types.js';

const log = createLogger('commands:persona');

const VALID_PERSONAS = new Set<string>(
  listPersonas().map((p) => p.type),
);

interface BrainLike {
  currentPersona?: string;
  getPersona?: () => string;
  setPersona?: (p: PersonaType) => void;
}

export const personaCommand: SlashCommand = {
  name: 'persona',
  description: 'Show the current persona or switch to a named one.',
  usage: '/persona [name]',

  async execute(args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId, args }, '/persona executed');

    const agentLoop = ctx.agentLoop as { brain?: BrainLike } | null;
    const brain: BrainLike | undefined = agentLoop?.brain;
    const target = args.trim().toLowerCase();

    if (!target) {
      const current = brain?.getPersona?.() ?? brain?.currentPersona ?? 'unknown';
      const available = listPersonas().map((p) => p.type).join(', ');
      return `Current persona: ${current}\nAvailable: ${available}`;
    }

    if (!VALID_PERSONAS.has(target)) {
      const available = listPersonas().map((p) => p.type).join(', ');
      return `Unknown persona: "${target}"\nAvailable: ${available}`;
    }

    if (!brain?.setPersona) {
      return `Persona switching not available. Requested: ${target}`;
    }

    try {
      brain.setPersona(target as PersonaType);
      log.info({ target }, 'Persona switched via /persona command');
      return `Persona switched to: ${target}`;
    } catch (err) {
      log.error({ target, err }, 'Failed to switch persona');
      return `Failed to switch persona to "${target}": ${String(err)}`;
    }
  },
};

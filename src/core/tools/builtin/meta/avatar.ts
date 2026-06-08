/**
 * meta.avatar — Avatar System tool.
 *
 * Actions:
 *   create         — Create a new avatar with name and style.
 *   set-expression — Set the active expression on an avatar.
 *   current        — Return the current active avatar.
 *   list           — List all avatars.
 *   plan-stream    — Generate a stream plan and pre-stream checklist.
 *   presence-card  — Generate SUDO's public presence / identity card.
 */

import path from 'node:path';
import { AvatarSystem } from '../../../embodiment/avatar-system.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-avatar');

const DB_PATH = MIND_DB;

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _system: AvatarSystem | null = null;

function getSystem(): AvatarSystem {
  if (!_system) _system = new AvatarSystem(DB_PATH);
  return _system;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const avatarTool: ToolDefinition = {
  name: 'meta.avatar',
  description:
    "Avatar System: manage SUDO's digital visual identity. Create avatars with different styles (anime, 3d, pixel, realistic), control expressions, plan live streams, and generate a presence card. Avatars are persisted to the database.",
  category: 'meta',
  timeout: 15_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['create', 'set-expression', 'current', 'list', 'plan-stream', 'presence-card'],
    },
    name: {
      type: 'string',
      description: '[create] Avatar display name (must be unique, e.g. "Nova").',
    },
    style: {
      type: 'string',
      description: '[create] Rendering style.',
      enum: ['3d', 'anime', 'pixel', 'realistic'],
      default: 'anime',
    },
    avatarId: {
      type: 'string',
      description: '[set-expression] UUID of the avatar to update.',
    },
    expression: {
      type: 'string',
      description: '[set-expression] Expression name to activate (e.g. "happy", "thinking").',
    },
    streamTitle: {
      type: 'string',
      description: '[plan-stream] Title of the planned stream.',
    },
    streamPlatform: {
      type: 'string',
      description: '[plan-stream] Streaming platform.',
      enum: ['youtube', 'twitch', 'kick', 'other'],
      default: 'youtube',
    },
    streamAvatarId: {
      type: 'string',
      description: '[plan-stream] Avatar UUID to use for the stream.',
    },
    streamDuration: {
      type: 'number',
      description: '[plan-stream] Planned stream duration in minutes.',
      default: 60,
    },
    streamTopics: {
      type: 'array',
      description: '[plan-stream] List of topics to cover.',
      items: { type: 'string', description: 'Topic string.' },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.avatar invoked');

    try {
      const sys = getSystem();

      switch (action) {
        // -------------------------------------------------------------------
        case 'create': {
          const name  = params['name'] as string | undefined;
          const style = (params['style'] as string | undefined) ?? 'anime';

          if (!name?.trim()) {
            return { success: false, output: 'name is required for create.' };
          }

          const avatar = sys.createAvatar(name, style);
          return {
            success: true,
            output:  `Avatar "${avatar.name}" created (id: ${avatar.id}, style: ${avatar.style}).`,
            data:    avatar,
          };
        }

        // -------------------------------------------------------------------
        case 'set-expression': {
          const avatarId   = params['avatarId'] as string | undefined;
          const expression = params['expression'] as string | undefined;

          if (!avatarId?.trim())   return { success: false, output: 'avatarId is required for set-expression.' };
          if (!expression?.trim()) return { success: false, output: 'expression is required for set-expression.' };

          sys.setExpression(avatarId, expression);
          return {
            success: true,
            output:  `Avatar ${avatarId} expression set to "${expression}".`,
            data:    { avatarId, expression },
          };
        }

        // -------------------------------------------------------------------
        case 'current': {
          const avatar = sys.getCurrentAvatar();
          if (!avatar) {
            return { success: true, output: 'No active avatar. Create one with action=create.', data: null };
          }
          return {
            success: true,
            output:  `Current avatar: "${avatar.name}" (${avatar.style}) — expression: ${avatar.currentExpression}`,
            data:    avatar,
          };
        }

        // -------------------------------------------------------------------
        case 'list': {
          const avatars = sys.getAvatars();
          if (avatars.length === 0) {
            return { success: true, output: 'No avatars found. Create one with action=create.', data: [] };
          }
          const lines = avatars.map(
            (a) => `[${a.id.slice(0, 8)}] "${a.name}" (${a.style}) — expression: ${a.currentExpression}`,
          );
          return {
            success: true,
            output:  `${avatars.length} avatar(s):\n${lines.join('\n')}`,
            data:    avatars,
          };
        }

        // -------------------------------------------------------------------
        case 'plan-stream': {
          const title    = params['streamTitle'] as string | undefined;
          const platform = (params['streamPlatform'] as string | undefined) ?? 'youtube';
          const avatarId = (params['streamAvatarId'] as string | undefined) ?? '';
          const duration = Math.max(1, (params['streamDuration'] as number | undefined) ?? 60);
          const topics   = (params['streamTopics'] as string[] | undefined) ?? [];

          if (!title?.trim()) return { success: false, output: 'streamTitle is required for plan-stream.' };

          const result = sys.planStream({ title, platform, avatarId, duration, topics });
          return {
            success: true,
            output:  `${result.plan}\n\nChecklist:\n${result.checklist.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`,
            data:    result,
          };
        }

        // -------------------------------------------------------------------
        case 'presence-card': {
          const card = sys.generatePresenceCard();
          const capList = card.capabilities.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
          return {
            success: true,
            output:  `${card.name} — ${card.role}\n\nCapabilities:\n${capList}\n\nAvatar: ${card.avatar ? `${card.avatar.name} (${card.avatar.style})` : 'none configured'}`,
            data:    card,
          };
        }

        // -------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.avatar error');
      return { success: false, output: `Avatar system error: ${msg}` };
    }
  },
};

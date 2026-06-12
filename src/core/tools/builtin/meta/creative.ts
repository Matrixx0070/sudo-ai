/**
 * meta.creative — Creative Origination tool for SUDO-AI.
 *
 * Actions:
 *   compose-music     — Generate a music composition (mood + duration)
 *   create-style      — Define a new visual art style
 *   evolve-style      — Evolve an existing style based on feedback
 *   story-framework   — Create a narrative story structure
 *   invent-format     — Invent a new content format for a niche
 *   library           — List all stored creative assets
 *   stats             — Return aggregate counts across all creative domains
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { CreativeEngine } from '../../../creative/creative-engine.js';
import { createLogger } from '../../../shared/logger.js';
import { formatMusic, formatStyle, formatFramework, formatFormat } from './creative-formatters.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-creative');
const DB_PATH = MIND_DB;

let _engine: CreativeEngine | null = null;
function getEngine(): CreativeEngine {
  if (!_engine) {
    _engine = new CreativeEngine(DB_PATH);
    logger.info({ dbPath: DB_PATH }, 'CreativeEngine singleton created');
  }
  return _engine;
}

export const creativeTool: ToolDefinition = {
  name: 'meta.creative',
  description:
    'Creative Origination engine. Composes original music, defines and evolves visual art styles, '
    + 'builds emotional narrative frameworks, and invents new content formats. '
    + 'All creative assets are stored persistently in mind.db. '
    + 'Actions: compose-music, create-style, evolve-style, story-framework, invent-format, library, stats.',
  category: 'meta',
  timeout: 30_000,

  parameters: {
    action: {
      type: 'string', required: true,
      description: 'Operation to perform.',
      enum: ['compose-music', 'create-style', 'evolve-style', 'story-framework', 'invent-format', 'library', 'stats'],
    },
    mood: {
      type: 'string',
      description: '[compose-music] Emotional mood.',
      enum: ['epic', 'suspense', 'uplifting', 'dark', 'playful'],
    },
    duration: {
      type: 'number',
      description: '[compose-music] Duration in seconds (10-600, default: 60).',
      default: 60,
    },
    name: { type: 'string', description: '[create-style] Name for the new art style.' },
    description: { type: 'string', description: '[create-style] Description of the art style vision.' },
    styleId: { type: 'string', description: '[evolve-style] ID of the art style to evolve.' },
    feedback: { type: 'string', description: '[evolve-style] Feedback or direction for the evolution.' },
    topic: { type: 'string', description: '[story-framework] Core topic for the narrative.' },
    emotion: {
      type: 'string',
      description: '[story-framework] Primary emotion: curiosity, tension, inspiration, nostalgia, excitement.',
    },
    niche: {
      type: 'string',
      description: '[invent-format] Content niche, e.g. "ai-tools", "coding", "tech".',
    },
    assetType: {
      type: 'string',
      description: '[library] Filter by: music, styles, frameworks, formats, all (default: all).',
      enum: ['music', 'styles', 'frameworks', 'formats', 'all'],
      default: 'all',
    },
    status: {
      type: 'string',
      description: '[library] Filter formats by status.',
      enum: ['concept', 'tested', 'proven', 'retired'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = (params['action'] as string | undefined)?.trim();
    logger.info({ session: ctx.sessionId, action }, 'meta.creative invoked');
    if (!action) return { success: false, output: 'action is required.' };

    try {
      const engine = getEngine();

      switch (action) {

        case 'compose-music': {
          const mood = (params['mood'] as string | undefined) ?? 'uplifting';
          const duration = typeof params['duration'] === 'number' ? params['duration'] : 60;
          const c = engine.composeMusic(mood, duration);
          logger.info({ id: c.id, mood, duration }, 'compose-music complete');
          return { success: true, output: `Music composition created:\n${formatMusic(c)}`, data: c };
        }

        case 'create-style': {
          const name = (params['name'] as string | undefined)?.trim();
          const description = (params['description'] as string | undefined)?.trim();
          if (!name) return { success: false, output: 'name is required for create-style.' };
          if (!description) return { success: false, output: 'description is required for create-style.' };
          const s = engine.createArtStyle(name, description);
          logger.info({ id: s.id, name }, 'create-style complete');
          return { success: true, output: `Art style created:\n${formatStyle(s)}`, data: s };
        }

        case 'evolve-style': {
          const styleId = (params['styleId'] as string | undefined)?.trim();
          const feedback = (params['feedback'] as string | undefined)?.trim();
          if (!styleId) return { success: false, output: 'styleId is required for evolve-style.' };
          if (!feedback) return { success: false, output: 'feedback is required for evolve-style.' };
          const evolved = engine.evolveStyle(styleId, feedback);
          logger.info({ id: evolved.id, fromId: styleId }, 'evolve-style complete');
          return { success: true, output: `Art style evolved to v${evolved.version}:\n${formatStyle(evolved)}`, data: evolved };
        }

        case 'story-framework': {
          const topic = (params['topic'] as string | undefined)?.trim();
          const emotion = (params['emotion'] as string | undefined)?.trim() ?? 'curiosity';
          if (!topic) return { success: false, output: 'topic is required for story-framework.' };
          const f = engine.createStoryFramework(topic, emotion);
          logger.info({ id: f.id, topic, emotion }, 'story-framework complete');
          const scenes = f.structure.map(s => `  Scene ${s.scene}: [${s.emotion}] ${s.beat} (${s.duration}s)`).join('\n');
          return { success: true, output: `Story framework created:\n${formatFramework(f)}\n\nScene breakdown:\n${scenes}`, data: f };
        }

        case 'invent-format': {
          const niche = (params['niche'] as string | undefined)?.trim();
          if (!niche) return { success: false, output: 'niche is required for invent-format.' };
          const fmt = engine.inventFormat(niche);
          logger.info({ id: fmt.id, niche }, 'invent-format complete');
          return { success: true, output: `Content format invented:\n${formatFormat(fmt)}`, data: fmt };
        }

        case 'library': {
          const assetType = (params['assetType'] as string | undefined) ?? 'all';
          const statusFilter = params['status'] as string | undefined;
          const lines: string[] = [];

          if (assetType === 'all' || assetType === 'music') {
            const music = engine.getMusicLibrary();
            lines.push(`Music Compositions (${music.length}):`, ...(music.length ? music.map(formatMusic) : ['  (none)']));
          }
          if (assetType === 'all' || assetType === 'styles') {
            const cur = engine.getCurrentStyle();
            lines.push(`\nArt Styles — current: ${cur ? `"${cur.name}" v${cur.version}` : 'none'}`);
          }
          if (assetType === 'all' || assetType === 'frameworks') {
            const frameworks = engine.getFrameworks();
            lines.push(`\nStory Frameworks (${frameworks.length}):`,
              ...(frameworks.length ? frameworks.slice(0, 10).map(formatFramework) : ['  (none)']));
          }
          if (assetType === 'all' || assetType === 'formats') {
            const formats = engine.getFormats(statusFilter);
            lines.push(`\nContent Formats (${formats.length}${statusFilter ? ` — ${statusFilter}` : ''}):`,
              ...(formats.length ? formats.slice(0, 10).map(formatFormat) : ['  (none)']));
          }
          return { success: true, output: lines.join('\n'), data: { assetType, statusFilter } };
        }

        case 'stats': {
          const stats = engine.getCreativeStats();
          const cur = engine.getCurrentStyle();
          const output = [
            'Creative Engine Statistics',
            `  Music compositions: ${stats.compositions}`,
            `  Art styles:         ${stats.styles}`,
            `  Story frameworks:   ${stats.frameworks}`,
            `  Content formats:    ${stats.formats}`,
            `  Current style:      ${cur ? `"${cur.name}" v${cur.version}` : 'none set'}`,
          ].join('\n');
          logger.info(stats, 'stats returned');
          return { success: true, output, data: { ...stats, currentStyle: cur } };
        }

        default:
          return {
            success: false,
            output: `Unknown action: "${action}". Valid: compose-music, create-style, evolve-style, story-framework, invent-format, library, stats.`,
          };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg, session: ctx.sessionId }, 'meta.creative error');
      return { success: false, output: `Creative engine error: ${msg}` };
    }
  },
};

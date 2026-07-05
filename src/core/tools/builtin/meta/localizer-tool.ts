/**
 * meta.localizer — Multi-Language Localization tool.
 *
 * Wraps Localizer to manage translation jobs, supported languages,
 * reach estimation, and job lifecycle tracking.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.localizer');

// ---------------------------------------------------------------------------
// Brain helper — mirror the pattern used in meta/index.ts
// ---------------------------------------------------------------------------

interface BrainLike {
  // Brain.chat() resolves to a STRING; must match Localizer's BrainLike (was { content }).
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

interface ConfigLike {
  brain?: BrainLike;
}

function extractBrain(ctx: ToolContext): BrainLike | undefined {
  return (ctx.config as ConfigLike | undefined)?.brain;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const localizerTool: ToolDefinition = {
  name: 'meta.localizer',
  description:
    'Multi-language content localization: create translation jobs, translate video scripts using AI, list jobs by status/language, view supported languages, get audience reach multiplier estimates. Target languages configurable via the language registry.',
  category: 'meta',
  timeout: 120_000, // translations can be slow
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['create-job', 'translate', 'list-jobs', 'languages', 'stats', 'reach-estimate'],
    },
    sourceVideoId: {
      type: 'string',
      description: 'Source video ID or identifier (required for create-job).',
    },
    targetLanguage: {
      type: 'string',
      description: 'Target language code: en, hi, ta, te, bn, pa, ur (required for create-job, translate).',
    },
    sourceLanguage: {
      type: 'string',
      description: 'Source language code (default: en).',
      default: 'en',
    },
    jobId: {
      type: 'string',
      description: 'Job ID (required for translate).',
    },
    sourceScript: {
      type: 'string',
      description: 'Full text of the script to translate (required for translate).',
    },
    filterStatus: {
      type: 'string',
      description: 'Filter jobs by status (optional for list-jobs).',
      enum: ['pending', 'translating', 'dubbing', 'reviewing', 'completed', 'failed'],
    },
    filterLanguage: {
      type: 'string',
      description: 'Filter jobs by target language code (optional for list-jobs).',
    },
    languages: {
      type: 'array',
      description: 'Array of language codes for reach-estimate (e.g. ["hi", "ur", "ta"]).',
      items: { type: 'string', description: 'Language code.' },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.localizer invoked');

    try {
      const { Localizer } = await import('../../../localization/localizer.js');
      const brain = extractBrain(ctx);
      const loc = new Localizer(undefined, brain);

      try {
        switch (action) {
          // ------------------------------------------------------------------
          case 'create-job': {
            const sourceVideoId = params['sourceVideoId'] as string | undefined;
            const targetLanguage = params['targetLanguage'] as string | undefined;
            if (!sourceVideoId?.trim()) return { success: false, output: 'sourceVideoId is required.' };
            if (!targetLanguage?.trim()) return { success: false, output: 'targetLanguage is required.' };

            const sourceLanguage = (params['sourceLanguage'] as string | undefined) ?? 'en';
            const id = loc.createJob(sourceVideoId, targetLanguage, sourceLanguage);
            return {
              success: true,
              output: `Localization job created (id: ${id}) — ${sourceLanguage} → ${targetLanguage} for video "${sourceVideoId}"`,
              data: { id, sourceVideoId, sourceLanguage, targetLanguage },
            };
          }

          // ------------------------------------------------------------------
          case 'translate': {
            const jobId = params['jobId'] as string | undefined;
            const sourceScript = params['sourceScript'] as string | undefined;
            if (!jobId?.trim()) return { success: false, output: 'jobId is required.' };
            if (!sourceScript?.trim()) return { success: false, output: 'sourceScript is required.' };

            const translated = await loc.translateScript(jobId, sourceScript);
            const job = loc.getJob(jobId);
            return {
              success: true,
              output: `Translation complete (job: ${jobId}).\n\nTranslated script:\n${translated}`,
              data: { jobId, translatedScript: translated, job },
            };
          }

          // ------------------------------------------------------------------
          case 'list-jobs': {
            const filterStatus = params['filterStatus'] as string | undefined;
            const filterLanguage = params['filterLanguage'] as string | undefined;
            const jobs = loc.listJobs({
              status: filterStatus,
              language: filterLanguage,
            });
            if (jobs.length === 0) return { success: true, output: 'No localization jobs found.', data: [] };
            const lines = jobs.map(
              (j) => `[${j.id.slice(0, 8)}] ${j.sourceVideoId} → ${j.targetLanguage} (${j.status})`,
            );
            return {
              success: true,
              output: `${jobs.length} job(s):\n${lines.join('\n')}`,
              data: jobs,
            };
          }

          // ------------------------------------------------------------------
          case 'languages': {
            const langs = loc.getSupportedLanguages();
            const lines = langs.map((l) => `  ${l.code}  ${l.name}`);
            return {
              success: true,
              output: `Supported languages (${langs.length}):\n${lines.join('\n')}`,
              data: langs,
            };
          }

          // ------------------------------------------------------------------
          case 'stats': {
            const stats = loc.getStats();
            const byLang = Object.entries(stats.byLanguage)
              .map(([code, n]) => `${code}: ${n}`)
              .join(', ');
            return {
              success: true,
              output: `Localization jobs — total: ${stats.total} | completed: ${stats.completed} | by language: ${byLang || 'none'}`,
              data: stats,
            };
          }

          // ------------------------------------------------------------------
          case 'reach-estimate': {
            const rawLangs = params['languages'];
            const languages: string[] = Array.isArray(rawLangs)
              ? (rawLangs as unknown[]).map(String)
              : typeof rawLangs === 'string'
              ? [rawLangs]
              : [];

            if (languages.length === 0) {
              return { success: false, output: 'languages array is required for reach-estimate.' };
            }

            const result = loc.estimateReachMultiplier(languages);
            return {
              success: true,
              output: `Reach multiplier: ${result.multiplier}x\n${result.reasoning}`,
              data: result,
            };
          }

          // ------------------------------------------------------------------
          default:
            return { success: false, output: `Unknown action: ${action}` };
        }
      } finally {
        loc.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.localizer error');
      return { success: false, output: `Localizer error: ${msg}` };
    }
  },
};

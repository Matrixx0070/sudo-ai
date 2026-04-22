/**
 * @file thumbnail-ab-tool.ts
 * @description meta.thumbnail-ab — SUDO-AI tool for Thumbnail A/B Testing.
 *
 * Actions:
 *   create-test   — create a new A/B test with 2-6 thumbnail variants
 *   start         — begin the measurement window for a test
 *   evaluate      — check if window has elapsed, fetch CTR, select winner
 *   active-tests  — list all tests in 'setup' or 'running' state
 *   history       — list completed and all tests (most recent first)
 *   results       — get full results for a specific test by ID
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { ThumbnailABTester } from '../../../youtube/thumbnail-ab.js';

const logger = createLogger('meta.thumbnail-ab');
const DB_PATH = path.resolve('data/mind.db');

function getTester(): ThumbnailABTester {
  return new ThumbnailABTester(DB_PATH);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTest(t: ReturnType<ThumbnailABTester['getTestResults']>): string {
  if (!t) return '(null)';
  const variantLines = t.variants.map(v => {
    const ctr = v.measuredCtr !== undefined ? ` | CTR: ${(v.measuredCtr * 100).toFixed(2)}%` : '';
    const impr = v.impressions !== undefined ? ` | Impressions: ${v.impressions.toLocaleString()}` : '';
    const winner = v.isWinner ? ' [WINNER]' : '';
    return `  Variant ${v.variant}${winner}: ${v.description}${ctr}${impr}\n    imagePath: ${v.imagePath}`;
  });
  return [
    `ID: ${t.id}`,
    `Video: ${t.videoId}`,
    `Status: ${t.status.toUpperCase()}`,
    `Measure after: ${t.measureAfterHours}h`,
    t.startedAt ? `Started: ${t.startedAt}` : null,
    t.completedAt ? `Completed: ${t.completedAt}` : null,
    t.winnerVariant ? `Winner: Variant ${t.winnerVariant}` : null,
    `Variants:\n${variantLines.join('\n')}`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const thumbnailABTool: ToolDefinition = {
  name: 'meta.thumbnail-ab',
  description:
    'Thumbnail A/B Testing system. Deploy 2-6 variant thumbnails for a video, run a measurement window, ' +
    'and automatically select the variant with the highest CTR as the winner. ' +
    'Results are persisted to mind.db. Requires YOUTUBE_API_KEY for live CTR data (gracefully degrades without it).',
  category: 'meta',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description:
        'Operation to perform: ' +
        '"create-test" — create a new A/B test for a video. ' +
        '"start" — begin the measurement window for a test. ' +
        '"evaluate" — check measurement window and select winner if elapsed. ' +
        '"active-tests" — list all running/setup tests. ' +
        '"history" — list all tests (most recent first). ' +
        '"results" — get full results for a specific test.',
      enum: ['create-test', 'start', 'evaluate', 'active-tests', 'history', 'results'],
    },
    videoId: {
      type: 'string',
      description: 'YouTube video ID to run the A/B test on (required for create-test).',
    },
    testId: {
      type: 'string',
      description: 'A/B test ID (required for start, evaluate, results).',
    },
    variants: {
      type: 'array',
      description:
        'Array of variant objects for create-test. Each must have: variant (label e.g. "A"), ' +
        'imagePath (absolute path to thumbnail image), description (short description). ' +
        'Minimum 2, maximum 6 variants.',
      items: {
        type: 'object',
        description: 'Variant definition.',
        properties: {
          variant:     { type: 'string', description: 'Variant label e.g. "A", "B", "C".' },
          imagePath:   { type: 'string', description: 'Absolute path to the thumbnail image file.' },
          description: { type: 'string', description: 'Human description of this variant.' },
        },
      },
    },
    measureAfterHours: {
      type: 'number',
      description: 'Hours to wait before measuring CTR and selecting winner (default: 48, range: 1-720).',
      default: 48,
    },
    limit: {
      type: 'number',
      description: 'Max number of results to return for history (default: 20, max: 200).',
      default: 20,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(params['action'] ?? '');
    logger.info({ session: ctx.sessionId, action }, 'meta.thumbnail-ab invoked');

    try {
      const tester = getTester();

      switch (action) {
        case 'create-test': {
          const videoId = params['videoId'] as string | undefined;
          if (!videoId?.trim()) return { success: false, output: 'videoId is required for create-test.' };

          const rawVariants = params['variants'] as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(rawVariants) || rawVariants.length < 2) {
            return { success: false, output: 'variants array with at least 2 items is required for create-test.' };
          }

          const variants = rawVariants.map((v, i) => ({
            videoId: videoId.trim(),
            variant:     String(v['variant']     ?? `${String.fromCharCode(65 + i)}`),
            imagePath:   String(v['imagePath']   ?? ''),
            description: String(v['description'] ?? ''),
          }));

          const measureAfterHours = Math.min(720, Math.max(1, Number(params['measureAfterHours'] ?? 48)));
          const test = tester.createTest(videoId.trim(), variants, measureAfterHours);
          logger.info({ testId: test.id, videoId }, 'A/B test created via tool');
          return {
            success: true,
            output: `A/B test created successfully.\n\n${formatTest(test)}\n\nRun action=start with testId="${test.id}" to begin the measurement window.`,
            data: test,
          };
        }

        case 'start': {
          const testId = params['testId'] as string | undefined;
          if (!testId?.trim()) return { success: false, output: 'testId is required for start.' };
          tester.startTest(testId.trim());
          const test = tester.getTestResults(testId.trim());
          logger.info({ testId }, 'A/B test started via tool');
          return {
            success: true,
            output: `Test started. Measurement window: ${test?.measureAfterHours ?? '?'}h.\n\n${formatTest(test)}`,
            data: test,
          };
        }

        case 'evaluate': {
          const testId = params['testId'] as string | undefined;
          if (!testId?.trim()) return { success: false, output: 'testId is required for evaluate.' };
          const test = await tester.evaluateTest(testId.trim());
          const statusMsg = test.status === 'completed'
            ? `Test completed. Winner: Variant ${test.winnerVariant ?? 'unknown'}.`
            : `Measurement window not yet elapsed. Check back later.`;
          logger.info({ testId, status: test.status }, 'A/B test evaluated via tool');
          return {
            success: true,
            output: `${statusMsg}\n\n${formatTest(test)}`,
            data: test,
          };
        }

        case 'active-tests': {
          const tests = tester.getActiveTests();
          if (tests.length === 0) {
            return { success: true, output: 'No active A/B tests found.', data: [] };
          }
          const lines = tests.map(t => `[${t.id.slice(0, 8)}] Video: ${t.videoId} | Status: ${t.status} | Variants: ${t.variants.length}`);
          return {
            success: true,
            output: `${tests.length} active test(s):\n${lines.join('\n')}`,
            data: tests,
          };
        }

        case 'history': {
          const limit = Math.min(200, Math.max(1, Number(params['limit'] ?? 20)));
          const tests = tester.getTestHistory(limit);
          if (tests.length === 0) {
            return { success: true, output: 'No A/B test history found.', data: [] };
          }
          const lines = tests.map(t => {
            const winnerNote = t.winnerVariant ? ` | Winner: ${t.winnerVariant}` : '';
            return `[${t.id.slice(0, 8)}] Video: ${t.videoId} | Status: ${t.status}${winnerNote} | Created: ${t.variants[0]?.deployedAt ?? 'n/a'}`;
          });
          return {
            success: true,
            output: `${tests.length} test(s) in history:\n${lines.join('\n')}`,
            data: tests,
          };
        }

        case 'results': {
          const testId = params['testId'] as string | undefined;
          if (!testId?.trim()) return { success: false, output: 'testId is required for results.' };
          const test = tester.getTestResults(testId.trim());
          if (!test) return { success: false, output: `Test not found: ${testId}` };
          return {
            success: true,
            output: formatTest(test),
            data: test,
          };
        }

        default:
          return { success: false, output: `Unknown action: "${action}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.thumbnail-ab error');
      return { success: false, output: `Thumbnail A/B error: ${msg}` };
    }
  },
};

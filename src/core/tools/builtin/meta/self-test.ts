/**
 * meta.self-test — SUDO-AI self-test and dry-run tool.
 *
 * Wraps the TestHarness class so the brain can invoke tests on demand
 * without needing direct module access.
 *
 * Actions:
 *   run-all       — Run the full self-test suite (all 8 checks)
 *   test-database — Verify all databases are readable and have correct tables
 *   test-brain    — Verify LLM providers are configured and sessions exist
 *   test-tools    — Verify tool categories are discoverable
 *   test-skills   — Verify custom skills load and are tracked
 *   dry-run       — Validate a tool+input pair without making real API calls
 *   history       — Show recent test run summaries
 */

import path from 'node:path';
import { TestHarness, type TestSuite, type TestResult } from '../../../testing/test-harness.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-self-test');

const DB_PATH = MIND_DB;

// ---------------------------------------------------------------------------
// Lazy singleton harness
// ---------------------------------------------------------------------------

let _harness: TestHarness | null = null;

function getHarness(): TestHarness {
  if (!_harness) {
    _harness = new TestHarness(DB_PATH);
  }
  return _harness;
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function formatSuite(suite: TestSuite): string {
  const statusLine = `${suite.name}: ${suite.passed} passed, ${suite.failed} failed (${suite.duration}ms)`;
  const testLines = suite.tests.map(t => {
    const icon = t.passed ? 'PASS' : 'FAIL';
    const detail = t.passed ? (t.output ?? '') : (t.error ?? 'unknown error');
    return `  [${icon}] ${t.name}: ${detail}`;
  });
  return [statusLine, ...testLines].join('\n');
}

function formatResult(result: TestResult): string {
  const icon = result.passed ? 'PASS' : 'FAIL';
  const detail = result.passed ? (result.output ?? '') : (result.error ?? 'unknown error');
  return `[${icon}] ${result.name} (${result.duration}ms): ${detail}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const selfTestTool: ToolDefinition = {
  name: 'meta.self-test',
  description:
    'Run SUDO-AI self-tests. Verify databases, brain, tools, skills, consciousness, channels, ' +
    'memory, and health without requiring external intervention. Supports dry-run mode to ' +
    'validate tool inputs without real API calls. View test history across sessions.',
  category: 'meta',
  timeout: 60_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Which test to run.',
      enum: ['run-all', 'test-database', 'test-brain', 'test-tools', 'test-skills', 'dry-run', 'history'],
    },
    toolName: {
      type: 'string',
      description: 'Tool name for dry-run mode (required when action=dry-run).',
    },
    input: {
      type: 'object',
      description: 'Input parameters for dry-run validation (required when action=dry-run).',
      properties: {},
    },
    limit: {
      type: 'number',
      description: 'Number of historical test runs to return (default 10, max 100). Used with action=history.',
      default: 10,
    },
    dryRun: {
      type: 'boolean',
      description: 'When true with test-tools, only check file existence (no dynamic imports).',
      default: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    logger.info({ session: ctx.sessionId, action }, 'meta.self-test invoked');

    if (!action?.trim()) {
      return { success: false, output: 'action is required' };
    }

    const harness = getHarness();

    try {
      switch (action) {
        case 'run-all': {
          const suite = await harness.runAll();
          const allPassed = suite.failed === 0;
          return {
            success: allPassed,
            output: formatSuite(suite),
            data: suite,
          };
        }

        case 'test-database': {
          const result = await harness.testDatabase();
          return {
            success: result.passed,
            output: formatResult(result),
            data: result,
          };
        }

        case 'test-brain': {
          const result = await harness.testBrain();
          return {
            success: result.passed,
            output: formatResult(result),
            data: result,
          };
        }

        case 'test-tools': {
          const useDry = (params['dryRun'] as boolean | undefined) ?? false;
          const result = await harness.testTools(useDry);
          return {
            success: result.passed,
            output: formatResult(result),
            data: result,
          };
        }

        case 'test-skills': {
          const result = await harness.testSkills();
          return {
            success: result.passed,
            output: formatResult(result),
            data: result,
          };
        }

        case 'dry-run': {
          const toolName = params['toolName'] as string | undefined;
          if (!toolName?.trim()) {
            return { success: false, output: 'toolName is required for dry-run' };
          }
          const input = params['input'] ?? {};
          const result = await harness.dryRun(toolName, input);
          return {
            success: result.passed,
            output: formatResult(result),
            data: result,
          };
        }

        case 'history': {
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number' && rawLimit > 0
            ? Math.min(Math.floor(rawLimit), 100)
            : 10;

          const history = harness.getHistory(limit);

          if (history.length === 0) {
            return { success: true, output: 'No test runs recorded yet.', data: [] };
          }

          const lines = history.map((suite, i) => {
            const status = suite.failed === 0 ? 'ALL PASS' : `${suite.failed} FAIL`;
            return `  ${i + 1}. "${suite.name}" — ${status} — ${suite.passed}/${suite.passed + suite.failed} (${suite.duration}ms)`;
          });

          return {
            success: true,
            output: `Last ${history.length} test run(s):\n${lines.join('\n')}`,
            data: history,
          };
        }

        default:
          return { success: false, output: `Unknown action: "${action}". Valid: run-all, test-database, test-brain, test-tools, test-skills, dry-run, history` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.self-test error');
      return { success: false, output: `Self-test error: ${msg}` };
    }
  },
};

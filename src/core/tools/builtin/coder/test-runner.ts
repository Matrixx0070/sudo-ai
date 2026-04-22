/**
 * coder.test — Run tests and parse results into a structured report.
 * Auto-detects vitest, jest, or mocha from package.json.
 * Parses pass/fail counts from command output.
 */

import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { safeJsonParse } from '../../../shared/utils.js';

const execFile = promisify(execFileCb);

type TestFramework = 'vitest' | 'jest' | 'mocha' | 'auto';

interface TestReport {
  framework: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration?: string;
  failures: FailureDetail[];
  raw: string;
}

interface FailureDetail {
  name: string;
  message: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

async function detectFramework(cwd: string): Promise<TestFramework> {
  try {
    const pkgRaw = await readFile(join(cwd, 'package.json'), 'utf-8');
    const pkg = safeJsonParse<Record<string, unknown>>(pkgRaw, {});
    const deps = { ...(pkg['dependencies'] as object ?? {}), ...(pkg['devDependencies'] as object ?? {}) };
    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps) return 'jest';
    if ('mocha' in deps) return 'mocha';
    // Check scripts
    const scripts = (pkg['scripts'] as Record<string, string>) ?? {};
    const testScript = scripts['test'] ?? '';
    if (testScript.includes('vitest')) return 'vitest';
    if (testScript.includes('jest')) return 'jest';
    if (testScript.includes('mocha')) return 'mocha';
  } catch { /* ignore */ }
  return 'vitest'; // default
}

// ---------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------

function buildVitestArgs(filter?: string): string[] {
  const args = ['run', '--reporter=verbose'];
  if (filter) args.push('--testNamePattern', filter);
  return args;
}

function buildJestArgs(filter?: string): string[] {
  const args = ['--no-coverage', '--colors=false'];
  if (filter) args.push('--testNamePattern', filter);
  return args;
}

function buildMochaArgs(filter?: string): string[] {
  const args = ['--reporter', 'spec'];
  if (filter) args.push('--grep', filter);
  return args;
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

function parseVitestOutput(output: string): Omit<TestReport, 'framework' | 'raw'> {
  const failures: FailureDetail[] = [];

  // Match: "Tests  5 passed | 2 failed"
  const summary = output.match(/Tests\s+([\d,]+)\s+passed[^|]*(?:\|\s*([\d,]+)\s+failed)?(?:[^|]*\|\s*([\d,]+)\s+skipped)?/i);
  let passed = 0, failed = 0, skipped = 0;
  if (summary) {
    passed = parseInt((summary[1] ?? '0').replace(',', ''), 10) || 0;
    failed = parseInt((summary[2] ?? '0').replace(',', ''), 10) || 0;
    skipped = parseInt((summary[3] ?? '0').replace(',', ''), 10) || 0;
  }

  // Duration
  const durationMatch = output.match(/Duration\s+([\d.]+\s*s)/i);
  const duration = durationMatch ? durationMatch[1] : undefined;

  // Failure blocks: lines starting with "FAIL" or "× " or "✗"
  const failLines = output.split('\n').filter((l) => /^\s*(?:×|✗|✕|FAIL)\s/.test(l));
  for (const fl of failLines) {
    failures.push({ name: fl.trim().replace(/^[×✗✕FAIL\s]+/, ''), message: 'Test failed' });
  }

  return { passed, failed, skipped, total: passed + failed + skipped, duration, failures };
}

function parseJestOutput(output: string): Omit<TestReport, 'framework' | 'raw'> {
  const failures: FailureDetail[] = [];

  const testsLine = output.match(/Tests?:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed)?/i);
  const failed = parseInt(testsLine?.[1] ?? '0', 10) || 0;
  const passed = parseInt(testsLine?.[2] ?? '0', 10) || 0;

  const durationMatch = output.match(/Time:\s*([\d.]+\s*s)/i);
  const duration = durationMatch?.[1];

  const failBlocks = output.match(/●\s+(.+)/g) ?? [];
  for (const block of failBlocks) {
    failures.push({ name: block.replace(/^●\s+/, '').trim(), message: 'Test failed' });
  }

  return { passed, failed, skipped: 0, total: passed + failed, duration, failures };
}

function parseMochaOutput(output: string): Omit<TestReport, 'framework' | 'raw'> {
  const passing = parseInt(output.match(/(\d+)\s+passing/i)?.[1] ?? '0', 10) || 0;
  const failing = parseInt(output.match(/(\d+)\s+failing/i)?.[1] ?? '0', 10) || 0;
  const pending = parseInt(output.match(/(\d+)\s+pending/i)?.[1] ?? '0', 10) || 0;
  const durationMatch = output.match(/(\d+ms)/);
  return { passed: passing, failed: failing, skipped: pending, total: passing + failing + pending, duration: durationMatch?.[1], failures: [] };
}

function buildReport(framework: TestFramework, parsed: Omit<TestReport, 'framework' | 'raw'>, raw: string): TestReport {
  return { framework: String(framework), ...parsed, raw };
}

function formatReport(report: TestReport): string {
  const statusIcon = report.failed > 0 ? 'FAIL' : 'PASS';
  const lines = [
    `${statusIcon} — ${report.framework} test results`,
    `${'─'.repeat(50)}`,
    `Passed:  ${report.passed}`,
    `Failed:  ${report.failed}`,
    `Skipped: ${report.skipped}`,
    `Total:   ${report.total}`,
  ];
  if (report.duration) lines.push(`Duration: ${report.duration}`);
  if (report.failures.length > 0) {
    lines.push('\nFailures:');
    for (const f of report.failures) {
      lines.push(`  - ${f.name}`);
      if (f.message && f.message !== 'Test failed') lines.push(`    ${f.message}`);
    }
  }
  return lines.join('\n');
}

export const testRunnerTool: ToolDefinition = {
  name: 'coder.test',
  description:
    'Run tests and return a structured report (pass/fail counts, failure details). ' +
    'Auto-detects vitest, jest, or mocha from package.json. ' +
    'Optionally filter by test name pattern.',
  category: 'coder',
  timeout: 120_000,
  parameters: {
    command: {
      type: 'string',
      required: false,
      description: 'Override the test runner (vitest|jest|mocha). Auto-detected if omitted.',
      enum: ['vitest', 'jest', 'mocha'],
    },
    cwd: {
      type: 'string',
      required: false,
      description: 'Directory containing package.json. Defaults to session working directory.',
    },
    filter: {
      type: 'string',
      required: false,
      description: 'Optional test name pattern/regex to run only matching tests.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const testCwd = typeof params['cwd'] === 'string'
      ? resolve(ctx.workingDir, params['cwd'])
      : ctx.workingDir;

    const filter = typeof params['filter'] === 'string' ? params['filter'] : undefined;

    const framework: TestFramework = (typeof params['command'] === 'string' && ['vitest', 'jest', 'mocha'].includes(params['command']))
      ? (params['command'] as TestFramework)
      : await detectFramework(testCwd);

    const args =
      framework === 'vitest' ? buildVitestArgs(filter) :
      framework === 'jest'   ? buildJestArgs(filter) :
                               buildMochaArgs(filter);

    log.info({ tool: 'coder.test', framework, args, cwd: testCwd }, 'Running tests');

    try {
      const { stdout, stderr } = await execFile(
        join(testCwd, 'node_modules', '.bin', framework),
        args,
        { cwd: testCwd, signal: ctx.signal, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } },
      );
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      const parsed =
        framework === 'vitest' ? parseVitestOutput(combined) :
        framework === 'jest'   ? parseJestOutput(combined) :
                                 parseMochaOutput(combined);
      const report = buildReport(framework, parsed, combined);
      log.info({ tool: 'coder.test', framework, passed: report.passed, failed: report.failed }, 'Tests complete');
      return { success: report.failed === 0, output: formatReport(report), data: report };
    } catch (err) {
      // execFile rejects on non-zero exit — test failures land here
      const exitErr = err as { stdout?: string; stderr?: string; message?: string };
      const combined = [exitErr.stdout ?? '', exitErr.stderr ?? ''].join('\n');
      const parsed =
        framework === 'vitest' ? parseVitestOutput(combined) :
        framework === 'jest'   ? parseJestOutput(combined) :
                                 parseMochaOutput(combined);
      const report = buildReport(framework, parsed, combined);
      if (report.total > 0) {
        log.info({ tool: 'coder.test', framework, passed: report.passed, failed: report.failed }, 'Tests finished with failures');
        return { success: false, output: formatReport(report), data: report };
      }
      const msg = exitErr.message ?? String(err);
      log.error({ tool: 'coder.test', framework, err }, 'Test runner failed to start');
      return { success: false, output: `coder.test error: ${msg}\n${combined}` };
    }
  },
};

export default testRunnerTool;

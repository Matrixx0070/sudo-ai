/**
 * @file self-test.ts
 * @description Nightly capability self-test — executes a curated slice of the
 * builtin tool surface against real runtime dependencies (exceljs, docx,
 * qrcode, sqlite, optionally chromium) and pushes a result summary through the
 * proactive notifier. Catches the vitest-passes-but-prod-broken class of
 * failure (ESM/CJS interop, missing native deps) on a schedule instead of at
 * the moment a user needs the tool.
 *
 * All cases are cheap, LLM-free, and write only under os.tmpdir().
 * Kill-switch: SUDO_SELFTEST_DISABLE=1. Browser probe: SUDO_SELFTEST_BROWSER=0.
 */

import { existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import * as proactiveNotifier from '../awareness/proactive-notifier.js';
import type { ToolContext, ToolResult } from '../tools/types.js';

const log = createLogger('health:self-test');

/** Structural slice of ToolRegistry used here — keeps tests trivial to stub. */
export interface SelfTestRegistry {
  get(name: string): unknown;
  execute(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface SelfTestResult {
  total: number;
  passed: number;
  failed: Array<{ name: string; error: string }>;
  skipped: string[];
  durationMs: number;
}

interface SelfTestCase {
  label: string;
  tool: string;
  params: Record<string, unknown>;
  /** When set, the file must exist and be non-empty after the call. */
  outFile?: string;
}

function buildCases(): SelfTestCase[] {
  const dir = tmpdir();
  const xlsx = join(dir, 'sudo-selftest.xlsx');
  const docx = join(dir, 'sudo-selftest.docx');
  return [
    {
      label: 'spreadsheet.create',
      tool: 'spreadsheet.create',
      outFile: xlsx,
      params: {
        outputPath: xlsx,
        sheets: [{
          name: 'Data',
          columns: [{ header: 'K', key: 'k' }, { header: 'V', key: 'v' }],
          rows: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }],
        }],
      },
    },
    { label: 'spreadsheet.read', tool: 'spreadsheet.read', params: { path: xlsx } },
    {
      label: 'docx.create',
      tool: 'docx.create',
      outFile: docx,
      params: { outputPath: docx, title: 'Self-test', sections: [{ heading: 'S', paragraphs: ['ok'] }] },
    },
    { label: 'media.qr', tool: 'media.qr', params: { text: 'sudo-ai self-test' } },
    { label: 'meta.health-check(system)', tool: 'meta.health-check', params: { action: 'system' } },
    { label: 'meta.health-check(databases)', tool: 'meta.health-check', params: { action: 'databases' } },
  ];
}

/** Chromium-dependent stable-refs probe — the tsx-serialization regression class. */
async function browserProbe(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { chromium } = await import('playwright-core');
    const { captureStableRefs } = await import('../tools/builtin/browser/stable-ref.js');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<button id="a">Alpha</button><a href="#">Beta</a>');
      const snapshot = await captureStableRefs(page);
      if (snapshot.refs.length > 0) return { ok: true };
      return { ok: false, error: 'captureStableRefs returned 0 refs' };
    } finally {
      await browser.close();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runCapabilitySelfTest(registry: SelfTestRegistry): Promise<SelfTestResult> {
  const started = Date.now();
  const result: SelfTestResult = { total: 0, passed: 0, failed: [], skipped: [], durationMs: 0 };

  if (process.env['SUDO_SELFTEST_DISABLE'] === '1') {
    result.skipped.push('all (SUDO_SELFTEST_DISABLE=1)');
    return result;
  }

  const ctx = { sessionId: 'selftest', config: {} } as ToolContext;
  const cases = buildCases();

  for (const c of cases) {
    if (!registry.get(c.tool)) {
      result.skipped.push(`${c.label} (not registered)`);
      continue;
    }
    result.total++;
    if (c.outFile) rmSync(c.outFile, { force: true });
    try {
      const r = await registry.execute(c.tool, c.params, ctx);
      const wrote = c.outFile ? existsSync(c.outFile) && statSync(c.outFile).size > 0 : true;
      if (r.success && wrote) {
        result.passed++;
      } else {
        result.failed.push({ name: c.label, error: r.success ? 'no output file written' : String(r.output).slice(0, 200) });
      }
    } catch (err) {
      result.failed.push({ name: c.label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (process.env['SUDO_SELFTEST_BROWSER'] !== '0') {
    result.total++;
    const probe = await browserProbe();
    if (probe.ok) result.passed++;
    else result.failed.push({ name: 'browser.stable-refs', error: probe.error ?? 'unknown' });
  } else {
    result.skipped.push('browser.stable-refs (SUDO_SELFTEST_BROWSER=0)');
  }

  result.durationMs = Date.now() - started;
  log.info(
    { total: result.total, passed: result.passed, failed: result.failed.length, skipped: result.skipped, durationMs: result.durationMs },
    'Capability self-test complete',
  );

  const failedList = result.failed.map((f) => `${f.name}: ${f.error}`).join(' | ').slice(0, 400);
  proactiveNotifier.notify(
    result.failed.length > 0 ? 'alert' : 'discovery',
    `Nightly self-test: ${result.passed}/${result.total} passed`,
    result.failed.length > 0
      ? `FAILURES — ${failedList}`
      : `All capability probes passed (${Math.round(result.durationMs / 1000)}s)${result.skipped.length ? `; skipped: ${result.skipped.join(', ')}` : ''}`,
    result.failed.length > 0 ? 'high' : 'low',
  );

  return result;
}

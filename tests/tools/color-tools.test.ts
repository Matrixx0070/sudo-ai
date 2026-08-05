/**
 * @file color-tools.test.ts
 * @description Tests for media.color-audit + media.color-check (grok color
 * skill port). The scripts are pure python + PIL, so live tests run everywhere
 * python3 + PIL exist.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import type { ToolContext } from '../../src/core/tools/types.js';

function makeCtx(): ToolContext {
  return { sessionId: 'test-session', workingDir: os.tmpdir(), config: null, logger: console } as ToolContext;
}

let liveOk = false;
let image = '';

beforeAll(async () => {
  try {
    await execFileAsync('python3', ['-c', 'import PIL'], { timeout: 15_000 });
    liveOk = true;
  } catch {
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'colortest-'));
  image = path.join(dir, 'img.png');
  const py = [
    'import sys',
    'from PIL import Image, ImageDraw',
    'img = Image.new("RGB", (200, 100), "#FFFFFF")',
    'ImageDraw.Draw(img).rectangle([0, 0, 200, 40], fill="#1E2761")',
    'img.save(sys.argv[1])',
  ].join('\n');
  await execFileAsync('python3', ['-c', py, image], { timeout: 30_000 });
}, 60_000);

describe('media.color-check', () => {
  it('rejects invalid hex and wrong arity', async () => {
    const { colorCheckTool } = await import('../../src/core/tools/builtin/media/tools/color-tools.js');
    const bad = await colorCheckTool.execute({ colors: ['red'] }, makeCtx());
    expect(bad.success).toBe(false);
    const three = await colorCheckTool.execute({ colors: ['#000000', '#FFFFFF', '#FF0000'] }, makeCtx());
    expect(three.success).toBe(false);
  });

  it('generates an 11-shade palette from one hex', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { colorCheckTool } = await import('../../src/core/tools/builtin/media/tools/color-tools.js');
    const r = await colorCheckTool.execute({ colors: ['#0D9488'] }, makeCtx());
    expect(r.success).toBe(true);
    expect((r.output.match(/#[0-9A-Fa-f]{6}/g) ?? []).length).toBeGreaterThanOrEqual(11);
  }, 60_000);

  it('reports contrast + CVD for a pair — including a FAILING pair', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { colorCheckTool } = await import('../../src/core/tools/builtin/media/tools/color-tools.js');
    // #777 on #999 fails WCAG — the script exits 1 with the report; still success here.
    const r = await colorCheckTool.execute({ colors: ['#777777', '#999999'] }, makeCtx());
    expect(r.success).toBe(true);
    expect(r.output).toContain('ratio');
  }, 60_000);
});

describe('media.color-audit', () => {
  it('rejects non-image and missing paths', async () => {
    const { colorAuditTool } = await import('../../src/core/tools/builtin/media/tools/color-tools.js');
    const bad = await colorAuditTool.execute({ imagePath: '/etc/passwd' }, makeCtx());
    expect(bad.success).toBe(false);
    const missing = await colorAuditTool.execute({ imagePath: '/tmp/definitely-not-there.png' }, makeCtx());
    expect(missing.success).toBe(false);
  });

  it('audits an image and reports dominant colors', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { colorAuditTool } = await import('../../src/core/tools/builtin/media/tools/color-tools.js');
    const r = await colorAuditTool.execute({ imagePath: image }, makeCtx());
    expect(r.success).toBe(true);
    expect(r.output.toUpperCase()).toContain('#FFFFFF');
  }, 60_000);
});

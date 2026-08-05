/**
 * @file pptx-edit.test.ts
 * @description Tests for pptx.inspect + pptx.unpack/add_slide/clean/pack (grok
 * pptx skill port). Validation tests run everywhere; the live round-trip runs
 * only when python3 + python-pptx are available (they are in dev/prod).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

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

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: os.tmpdir(),
    config: null,
    logger: console,
    ...overrides,
  };
}

let pythonOk = false;
let fixture = '';

beforeAll(async () => {
  try {
    await execFileAsync('python3', ['-c', 'import pptx'], { timeout: 15_000 });
    pythonOk = true;
  } catch {
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pptxtest-'));
  fixture = path.join(dir, 'fixture.pptx');
  const py = [
    'from pptx import Presentation',
    'import sys',
    'prs = Presentation()',
    's1 = prs.slides.add_slide(prs.slide_layouts[0])',
    's1.shapes.title.text = "Alpha"',
    's2 = prs.slides.add_slide(prs.slide_layouts[1])',
    's2.shapes.title.text = "Beta"',
    's2.placeholders[1].text = "one\\ntwo"',
    'prs.save(sys.argv[1])',
  ].join('\n');
  await execFileAsync('python3', ['-c', py, fixture], { timeout: 30_000 });
}, 60_000);

// ---------------------------------------------------------------------------
// validation (no python needed)
// ---------------------------------------------------------------------------

describe('pptx edit tools — validation', () => {
  it('pptx.inspect rejects non-pptx extension', async () => {
    const { pptxInspectTool } = await import('../../src/core/tools/builtin/pptx/tools/inspect.js');
    const r = await pptxInspectTool.execute({ inputPath: '/tmp/x.docx' }, makeCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('.pptx');
  });

  it('pptx.inspect rejects path outside allowed dirs', async () => {
    const { pptxInspectTool } = await import('../../src/core/tools/builtin/pptx/tools/inspect.js');
    const r = await pptxInspectTool.execute({ inputPath: '/etc/x.pptx' }, makeCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('must be under');
  });

  it('pptx.unpack rejects disallowed input and missing file', async () => {
    const { pptxUnpackTool } = await import('../../src/core/tools/builtin/pptx/tools/edit.js');
    const bad = await pptxUnpackTool.execute({ inputPath: '/etc/x.pptx', outputDir: '/tmp/u' }, makeCtx());
    expect(bad.success).toBe(false);
    const missing = await pptxUnpackTool.execute(
      { inputPath: '/tmp/definitely-not-there.pptx', outputDir: '/tmp/u' },
      makeCtx(),
    );
    expect(missing.success).toBe(false);
    expect(missing.output).toContain('not found');
  });

  it('pptx.add_slide rejects a non-unpacked dir and a path-traversal source', async () => {
    const { pptxAddSlideTool } = await import('../../src/core/tools/builtin/pptx/tools/edit.js');
    const notDir = await pptxAddSlideTool.execute({ dir: '/tmp/nope-not-a-dir', source: 'slide1.xml' }, makeCtx());
    expect(notDir.success).toBe(false);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'pptxbad-'));
    try {
      const notUnpacked = await pptxAddSlideTool.execute({ dir: tmp, source: 'slide1.xml' }, makeCtx());
      expect(notUnpacked.success).toBe(false);
      expect(notUnpacked.output).toContain('presentation.xml');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('pptx.pack rejects disallowed outputPath', async () => {
    const { pptxPackTool } = await import('../../src/core/tools/builtin/pptx/tools/edit.js');
    const r = await pptxPackTool.execute({ dir: '/tmp/nope', outputPath: '/etc/x.pptx' }, makeCtx());
    expect(r.success).toBe(false);
  });

  it('slide-edit v2 tools validate refs and register (12 pptx tools)', async () => {
    const { pptxDeleteSlideTool, pptxSetTextTool } = await import(
      '../../src/core/tools/builtin/pptx/tools/slide-edit.js'
    );
    const noRefs = await pptxDeleteSlideTool.execute({ dir: '/tmp/nope' }, makeCtx());
    expect(noRefs.success).toBe(false);
    const badRef = await pptxSetTextTool.execute(
      { dir: '/tmp/nope', slide: '../evil.xml', placeholder: 'ctrTitle', text: 'x' },
      makeCtx(),
    );
    expect(badRef.success).toBe(false);
    const { PPTX_TOOLS } = await import('../../src/core/tools/builtin/pptx/index.js');
    const names = PPTX_TOOLS.map((t) => t.name);
    for (const n of ['pptx.delete_slide', 'pptx.set_text', 'pptx.inspect_slides', 'pptx.check_overlaps', 'pptx.render_slides']) {
      expect(names).toContain(n);
    }
    expect(PPTX_TOOLS.length).toBe(13);
  });

  it('pptx.find_template searches the vendored taxonomy', async () => {
    const { pptxFindTemplateTool } = await import('../../src/core/tools/builtin/pptx/tools/templates.js');
    const empty = await pptxFindTemplateTool.execute({}, makeCtx());
    expect(empty.success).toBe(false);
    const r = await pptxFindTemplateTool.execute({ query: 'minimalist corporate', limit: 3 }, makeCtx());
    expect(r.success).toBe(true);
    const entries = (r.data as { entries: Array<{ stem: string; templatePath: string }> }).entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(entries[0]!.templatePath).toContain('/templates/');
    expect(r.output).not.toContain('missing on disk');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// live round-trip (python3 + python-pptx)
// ---------------------------------------------------------------------------

describe('pptx edit tools — live round-trip', () => {
  it('inspect → unpack → add_slide → sldIdLst insert → clean → pack → reinspect', async (ctx) => {
    if (!pythonOk) return ctx.skip();
    const { pptxInspectTool } = await import('../../src/core/tools/builtin/pptx/tools/inspect.js');
    const { pptxUnpackTool, pptxAddSlideTool, pptxCleanTool, pptxPackTool } = await import(
      '../../src/core/tools/builtin/pptx/tools/edit.js'
    );
    const work = await mkdtemp(path.join(os.tmpdir(), 'pptxrt-'));
    const unpacked = path.join(work, 'unpacked');
    const out = path.join(work, 'out.pptx');
    try {
      const insp = await pptxInspectTool.execute({ inputPath: fixture, text: true }, makeCtx());
      expect(insp.success).toBe(true);
      expect(insp.output).toContain('Slides: 2');
      expect(insp.output).toContain('Alpha');

      const un = await pptxUnpackTool.execute({ inputPath: fixture, outputDir: unpacked }, makeCtx());
      expect(un.success).toBe(true);
      expect((un.data as { slides: string[] }).slides).toEqual(['slide1.xml', 'slide2.xml']);

      const add = await pptxAddSlideTool.execute({ dir: unpacked, source: 'slide2.xml' }, makeCtx());
      expect(add.success).toBe(true);
      const sldId = add.output.match(/<p:sldId[^>]*\/>/)?.[0];
      expect(sldId).toBeTruthy();

      const presPath = path.join(unpacked, 'ppt', 'presentation.xml');
      const pres = await readFile(presPath, 'utf8');
      await writeFile(presPath, pres.replace('</p:sldIdLst>', `${sldId}</p:sldIdLst>`), 'utf8');

      const clean = await pptxCleanTool.execute({ dir: unpacked }, makeCtx());
      expect(clean.success).toBe(true);

      const pack = await pptxPackTool.execute(
        { dir: unpacked, outputPath: out, originalPath: fixture },
        makeCtx(),
      );
      expect(pack.success).toBe(true);
      expect(pack.output).toContain('PASSED');

      const re = await pptxInspectTool.execute({ inputPath: out }, makeCtx());
      expect(re.success).toBe(true);
      expect(re.output).toContain('Slides: 3');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  it('pptx.unpack refuses a non-empty outputDir', async (ctx) => {
    if (!pythonOk) return ctx.skip();
    const { pptxUnpackTool } = await import('../../src/core/tools/builtin/pptx/tools/edit.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pptxfull-'));
    try {
      await writeFile(path.join(dir, 'existing.txt'), 'x', 'utf8');
      const r = await pptxUnpackTool.execute({ inputPath: fixture, outputDir: dir }, makeCtx());
      expect(r.success).toBe(false);
      expect(r.output).toContain('not empty');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

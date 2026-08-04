/**
 * @file docx-convert.test.ts
 * @description Tests for docx.convert + docx.render (LibreOffice-backed).
 * Validation tests run everywhere; live conversions run only when soffice and
 * python-docx are available (they are in dev/prod after the 2026-08-04 install).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, rm } from 'node:fs/promises';

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

let sofficeOk = false;
let fixture = '';

beforeAll(async () => {
  try {
    await execFileAsync('soffice', ['--version'], { timeout: 30_000 });
    await execFileAsync('python3', ['-c', 'import docx'], { timeout: 15_000 });
    sofficeOk = true;
  } catch {
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docxconv-'));
  fixture = path.join(dir, 'fixture.docx');
  const py = [
    'from docx import Document',
    'import sys',
    'd = Document()',
    'd.add_heading("Conv Test", 0)',
    'd.add_paragraph("body one")',
    'd.add_page_break()',
    'd.add_paragraph("page two")',
    'd.save(sys.argv[1])',
  ].join('\n');
  await execFileAsync('python3', ['-c', py, fixture], { timeout: 30_000 });
}, 90_000);

describe('docx.convert — validation', () => {
  it('rejects an unknown target format', async () => {
    const { docxConvertTool } = await import('../../src/core/tools/builtin/docx/tools/convert.js');
    const r = await docxConvertTool.execute({ inputPath: '/tmp/x.docx', to: 'exe' }, makeCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('`to` must be');
  });

  it('rejects input outside allowed dirs', async () => {
    const { docxConvertTool } = await import('../../src/core/tools/builtin/docx/tools/convert.js');
    const r = await docxConvertTool.execute({ inputPath: '/etc/x.docx', to: 'pdf' }, makeCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('must be under');
  });

  it('rejects .docx input for to:"docx" (only .doc/.dotx upgrade)', async () => {
    const { docxConvertTool } = await import('../../src/core/tools/builtin/docx/tools/convert.js');
    const r = await docxConvertTool.execute({ inputPath: '/tmp/x.docx', to: 'docx' }, makeCtx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('unsupported extension');
  });

  it('docx.render rejects outputPrefix outside allowed dirs', async () => {
    const { docxRenderTool } = await import('../../src/core/tools/builtin/docx/tools/convert.js');
    const r = await docxRenderTool.execute({ inputPath: '/tmp/x.docx', outputPrefix: '/etc/x' }, makeCtx());
    expect(r.success).toBe(false);
  });
});

describe('docx.convert / docx.render — live (soffice)', () => {
  it('converts docx → pdf and → images', async (ctx) => {
    if (!sofficeOk) return ctx.skip();
    const { docxConvertTool } = await import('../../src/core/tools/builtin/docx/tools/convert.js');
    const out = await mkdtemp(path.join(os.tmpdir(), 'docxconvout-'));
    try {
      const pdf = await docxConvertTool.execute({ inputPath: fixture, to: 'pdf', outputDir: out }, makeCtx());
      expect(pdf.success).toBe(true);
      await access(path.join(out, 'fixture.pdf'));

      const imgs = await docxConvertTool.execute({ inputPath: fixture, to: 'images', outputDir: out }, makeCtx());
      expect(imgs.success).toBe(true);
      const created = (imgs.data as { created: string[] }).created;
      expect(created.length).toBeGreaterThanOrEqual(2);
      await access(created[0]!);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 150_000);

  it('renders a labeled page grid', async (ctx) => {
    if (!sofficeOk) return ctx.skip();
    const { docxRenderTool } = await import('../../src/core/tools/builtin/docx/tools/convert.js');
    const out = await mkdtemp(path.join(os.tmpdir(), 'docxrender-'));
    try {
      const r = await docxRenderTool.execute(
        { inputPath: fixture, outputPrefix: path.join(out, 'grid'), cols: 2 },
        makeCtx(),
      );
      expect(r.success).toBe(true);
      expect((r.data as { created: string[] }).created).toContain(path.join(out, 'grid.jpg'));
      await access(path.join(out, 'grid.jpg'));
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 150_000);
});

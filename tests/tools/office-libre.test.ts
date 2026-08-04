/**
 * @file office-libre.test.ts
 * @description Tests for the three LibreOffice-backed skill-port tools added
 * 2026-08-04: spreadsheet.recalc, pptx.thumbnail, docx.accept_changes.
 * Validation tests run everywhere; live tests need soffice (+calc) and the
 * python libs and skip cleanly when absent.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp } from 'node:fs/promises';

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
let workDir = '';

beforeAll(async () => {
  try {
    await execFileAsync('soffice', ['--version'], { timeout: 30_000 });
    await execFileAsync('python3', ['-c', 'import openpyxl, pptx'], { timeout: 15_000 });
    liveOk = true;
  } catch {
    return;
  }
  workDir = await mkdtemp(path.join(os.tmpdir(), 'officelibre-'));
  const py = [
    'import sys',
    'from openpyxl import Workbook',
    'wb = Workbook(); ws = wb.active',
    'ws["A1"] = 10; ws["A2"] = 5; ws["A3"] = "=A1+A2"; ws["B1"] = "=A1/0"',
    'wb.save(sys.argv[1] + "/f.xlsx")',
    'from pptx import Presentation',
    'prs = Presentation()',
    's = prs.slides.add_slide(prs.slide_layouts[0]); s.shapes.title.text = "T"',
    'prs.save(sys.argv[1] + "/f.pptx")',
  ].join('\n');
  await execFileAsync('python3', ['-c', py, workDir], { timeout: 30_000 });
}, 90_000);

describe('LibreOffice skill-port tools — validation', () => {
  it('spreadsheet.recalc rejects bad extension and disallowed path', async () => {
    const { spreadsheetRecalcTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/recalc.js');
    const ext = await spreadsheetRecalcTool.execute({ inputPath: '/tmp/x.csv' }, makeCtx());
    expect(ext.success).toBe(false);
    const dir = await spreadsheetRecalcTool.execute({ inputPath: '/etc/x.xlsx' }, makeCtx());
    expect(dir.success).toBe(false);
    expect(dir.output).toContain('must be under');
  });

  it('pptx.thumbnail rejects disallowed input and outputPrefix', async () => {
    const { pptxThumbnailTool } = await import('../../src/core/tools/builtin/pptx/tools/thumbnail.js');
    const bad = await pptxThumbnailTool.execute({ inputPath: '/etc/x.pptx' }, makeCtx());
    expect(bad.success).toBe(false);
    const out = await pptxThumbnailTool.execute({ inputPath: '/tmp/missing.pptx' }, makeCtx());
    expect(out.success).toBe(false);
    expect(out.output).toContain('not found');
  });

  it('docx.accept_changes rejects disallowed outputPath', async () => {
    const { docxAcceptChangesTool } = await import('../../src/core/tools/builtin/docx/tools/convert.js');
    const r = await docxAcceptChangesTool.execute(
      { inputPath: '/tmp/missing.docx', outputPath: '/etc/x.docx' },
      makeCtx(),
    );
    expect(r.success).toBe(false);
  });

  it('registration includes the three new tools', async () => {
    const { DOCX_TOOLS } = await import('../../src/core/tools/builtin/docx/index.js');
    const { PPTX_TOOLS } = await import('../../src/core/tools/builtin/pptx/index.js');
    const { SPREADSHEET_TOOLS } = await import('../../src/core/tools/builtin/spreadsheet/index.js');
    expect(DOCX_TOOLS.map((t) => t.name)).toContain('docx.accept_changes');
    expect(PPTX_TOOLS.map((t) => t.name)).toContain('pptx.thumbnail');
    expect(SPREADSHEET_TOOLS.map((t) => t.name)).toContain('spreadsheet.recalc');
    expect(PPTX_TOOLS.length).toBe(12);
    expect(DOCX_TOOLS.length).toBe(7);
  });
});

describe('LibreOffice skill-port tools — live', () => {
  it('spreadsheet.recalc computes formulas and reports #DIV/0! with location', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { spreadsheetRecalcTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/recalc.js');
    const r = await spreadsheetRecalcTool.execute({ inputPath: path.join(workDir, 'f.xlsx') }, makeCtx());
    expect(r.success).toBe(true);
    const data = r.data as { status: string; total_errors: number; total_formulas: number };
    expect(data.status).toBe('errors_found');
    expect(data.total_errors).toBe(1);
    expect(data.total_formulas).toBe(2);
    expect(r.output).toContain('#DIV/0!');
  }, 120_000);

  it('pptx.thumbnail creates a labeled grid jpg', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { pptxThumbnailTool } = await import('../../src/core/tools/builtin/pptx/tools/thumbnail.js');
    const prefix = path.join(workDir, 'thumbs');
    const r = await pptxThumbnailTool.execute({ inputPath: path.join(workDir, 'f.pptx'), outputPrefix: prefix }, makeCtx());
    expect(r.success).toBe(true);
    await access(`${prefix}.jpg`);
  }, 150_000);
});

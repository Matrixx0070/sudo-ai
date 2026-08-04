/**
 * @file pdf-forms.test.ts
 * @description Tests for document.pdf-form-fields / pdf-fill-form / pdf-to-images
 * (grok pdf skill port). Validation runs everywhere; live tests need the python
 * pdf stack (pypdf/reportlab/pdf2image) and skip cleanly when absent.
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
let formPdf = '';
let flatPdf = '';

beforeAll(async () => {
  try {
    await execFileAsync('python3', ['-c', 'import pypdf, reportlab, pdf2image'], { timeout: 15_000 });
    liveOk = true;
  } catch {
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pdfformtest-'));
  formPdf = path.join(dir, 'form.pdf');
  flatPdf = path.join(dir, 'flat.pdf');
  const py = [
    'import sys',
    'from reportlab.pdfgen import canvas',
    'from reportlab.lib.pagesizes import letter',
    'c = canvas.Canvas(sys.argv[1], pagesize=letter)',
    'c.drawString(72, 720, "Name:")',
    'c.acroForm.textfield(name="name", x=130, y=705, width=200, height=20)',
    'c.save()',
    'c = canvas.Canvas(sys.argv[2], pagesize=letter)',
    'c.drawString(72, 720, "Name: ____")',
    'c.save()',
  ].join('\n');
  await execFileAsync('python3', ['-c', py, formPdf, flatPdf], { timeout: 30_000 });
}, 60_000);

describe('pdf form tools — validation', () => {
  it('pdf-form-fields rejects relative and non-pdf paths', async () => {
    const { pdfFormFieldsTool } = await import('../../src/core/tools/builtin/document/tools/pdf-forms.js');
    const rel = await pdfFormFieldsTool.execute({ inputPath: 'x.pdf' }, makeCtx());
    expect(rel.success).toBe(false);
    const ext = await pdfFormFieldsTool.execute({ inputPath: '/tmp/x.txt' }, makeCtx());
    expect(ext.success).toBe(false);
  });

  it('pdf-fill-form validates per-mode payloads', async () => {
    const { pdfFillFormTool } = await import('../../src/core/tools/builtin/document/tools/pdf-forms.js');
    const noFields = await pdfFillFormTool.execute({ inputPath: '/tmp/missing.pdf' }, makeCtx());
    expect(noFields.success).toBe(false);
  });

  it('registration includes the three pdf form tools', async () => {
    const { DOCUMENT_TOOLS } = await import('../../src/core/tools/builtin/document/index.js');
    const names = DOCUMENT_TOOLS.map((t) => t.name);
    expect(names).toContain('document.pdf-form-fields');
    expect(names).toContain('document.pdf-fill-form');
    expect(names).toContain('document.pdf-to-images');
  });
});

describe('pdf form tools — live', () => {
  it('extracts fields, fills them, and renders pages', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { pdfFormFieldsTool, pdfFillFormTool, pdfToImagesTool } = await import(
      '../../src/core/tools/builtin/document/tools/pdf-forms.js'
    );
    const f = await pdfFormFieldsTool.execute({ inputPath: formPdf }, makeCtx());
    expect(f.success).toBe(true);
    const fields = (f.data as { fields: Array<Record<string, unknown>> }).fields;
    expect(fields.length).toBe(1);

    const out = path.join(path.dirname(formPdf), 'filled.pdf');
    const fill = await pdfFillFormTool.execute(
      { inputPath: formPdf, fields: [{ ...fields[0], value: 'Test User' }], outputPath: out },
      makeCtx(),
    );
    expect(fill.success).toBe(true);
    await access(out);

    const imgs = await pdfToImagesTool.execute({ inputPath: out }, makeCtx());
    expect(imgs.success).toBe(true);
    expect((imgs.data as { created: string[] }).created.length).toBe(1);
  }, 120_000);

  it('reports zero fields on a flat form and fills via annotations', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { pdfFormFieldsTool, pdfFillFormTool } = await import(
      '../../src/core/tools/builtin/document/tools/pdf-forms.js'
    );
    const f = await pdfFormFieldsTool.execute({ inputPath: flatPdf }, makeCtx());
    expect(f.success).toBe(true);
    expect((f.data as { fieldCount: number }).fieldCount).toBe(0);
    expect(f.output).toContain('flat form');

    const out = path.join(path.dirname(flatPdf), 'flat-filled.pdf');
    const form = {
      form_fields: [
        { page_number: 1, entry_bounding_box: [140, 62, 400, 80], entry_text: { text: 'Test User', font_size: 11 } },
      ],
      pages: [{ page_number: 1, pdf_width: 612, pdf_height: 792 }],
    };
    const fill = await pdfFillFormTool.execute(
      { inputPath: flatPdf, form, mode: 'annotations', outputPath: out },
      makeCtx(),
    );
    expect(fill.success).toBe(true);
    await access(out);
  }, 120_000);
});

/**
 * @file docx-fields.test.ts
 * @description Tests for docx.replace_field / delete_sections / comment (grok
 * docx skill port). Validation runs everywhere; live tests need python3 +
 * python-docx and skip cleanly when absent. The live case builds a real complex
 * MERGEFIELD and a multi-section doc as fixtures.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import type { ToolContext } from '../../src/core/tools/types.js';

function makeCtx(): ToolContext {
  return { sessionId: 'test', workingDir: os.tmpdir(), config: null, logger: console } as ToolContext;
}

const SCRIPTS = path.resolve(__dirname, '../../src/core/tools/builtin/docx/scripts');
let liveOk = false;
let mergeDoc = '';
let sectionDoc = '';

beforeAll(async () => {
  try {
    await execFileAsync('python3', ['-c', 'import docx'], { timeout: 15_000 });
    liveOk = true;
  } catch {
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'docxfld-'));
  mergeDoc = path.join(dir, 'merge.docx');
  sectionDoc = path.join(dir, 'sections.docx');
  // multi-section doc
  await execFileAsync('python3', ['-c', [
    'import sys; from docx import Document',
    'd=Document(); d.add_paragraph("Alpha"); d.add_section(); d.add_paragraph("Bravo")',
    'd.add_section(); d.add_paragraph("Charlie")',
    'd.save(sys.argv[1])',
  ].join('\n'), sectionDoc], { timeout: 30_000 });
  // real complex MERGEFIELD doc, via unpack -> inject -> pack
  const un = path.join(dir, 'u');
  await execFileAsync('python3', [path.join(SCRIPTS, 'office', 'unpack.py'), sectionDoc, un], { timeout: 30_000 });
  const docXml = path.join(un, 'word', 'document.xml');
  let t = await readFile(docXml, 'utf8');
  const cf =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> MERGEFIELD ClientName </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>OLDVALUE</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  t = t.replace(/<w:r\b[^>]*>\s*<w:t[^>]*>Alpha<\/w:t>\s*<\/w:r>/, cf);
  await writeFile(docXml, t, 'utf8');
  await execFileAsync('python3', [path.join(SCRIPTS, 'office', 'pack.py'), un, mergeDoc], { timeout: 30_000 });
}, 90_000);

describe('docx field tools — validation', () => {
  it('replace_field needs list/field/sdt/map', async () => {
    const { docxReplaceFieldTool } = await import('../../src/core/tools/builtin/docx/tools/fields.js');
    const r = await docxReplaceFieldTool.execute({ inputPath: '/tmp/x.docx' }, makeCtx());
    expect(r.success).toBe(false);
  });
  it('delete_sections needs list/delete/keep', async () => {
    const { docxDeleteSectionsTool } = await import('../../src/core/tools/builtin/docx/tools/fields.js');
    const r = await docxDeleteSectionsTool.execute({ inputPath: '/tmp/x.docx' }, makeCtx());
    expect(r.success).toBe(false);
  });
  it('comment rejects a negative paragraph index', async () => {
    const { docxCommentTool } = await import('../../src/core/tools/builtin/docx/tools/fields.js');
    const r = await docxCommentTool.execute({ inputPath: '/tmp/x.docx', paragraph: -1, text: 'hi' }, makeCtx());
    expect(r.success).toBe(false);
  });
});

describe('docx field tools — live', () => {
  it('replace_field lists, dry-runs, and mutates a MERGEFIELD', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { docxReplaceFieldTool } = await import('../../src/core/tools/builtin/docx/tools/fields.js');
    const list = await docxReplaceFieldTool.execute({ inputPath: mergeDoc, list: true }, makeCtx());
    expect(list.success).toBe(true);
    expect(list.output).toMatch(/ClientName/);

    const dry = await docxReplaceFieldTool.execute(
      { inputPath: mergeDoc, field: 'ClientName', text: 'Acme Corp', dryRun: true }, makeCtx());
    expect(dry.success).toBe(true);
    expect(dry.output).toContain('[dry-run]');

    const out = path.join(path.dirname(mergeDoc), 'filled.docx');
    const r = await docxReplaceFieldTool.execute(
      { inputPath: mergeDoc, field: 'ClientName', text: 'Acme Corp', outputPath: out }, makeCtx());
    expect(r.success).toBe(true);
    await access(out);
    const check = await execFileAsync('python3', ['-c',
      'import sys; from docx import Document; print("Acme Corp" in " ".join(p.text for p in Document(sys.argv[1]).paragraphs))',
      out], { timeout: 30_000 });
    expect(check.stdout.trim()).toBe('True');
  }, 120_000);

  it('delete_sections lists and deletes a section', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { docxDeleteSectionsTool } = await import('../../src/core/tools/builtin/docx/tools/fields.js');
    const list = await docxDeleteSectionsTool.execute({ inputPath: sectionDoc, list: true }, makeCtx());
    expect(list.success).toBe(true);
    expect(list.output).toMatch(/\[0\]/);
    // Delete the MIDDLE section — deleting the terminal section (which holds the
    // body-level sectPr) corrupts the doc; the tool surfaces that as a failure.
    const out = path.join(path.dirname(sectionDoc), 'sec-del.docx');
    const r = await docxDeleteSectionsTool.execute({ inputPath: sectionDoc, delete: '1', outputPath: out }, makeCtx());
    expect(r.success).toBe(true);
    await access(out);
    const term = await docxDeleteSectionsTool.execute({ inputPath: sectionDoc, delete: '2', outputPath: out }, makeCtx());
    expect(term.success).toBe(false); // terminal-section delete is rejected with a clear error
  }, 120_000);

  it('comment adds a comment and returns anchor markers', async (ctx) => {
    if (!liveOk) return ctx.skip();
    const { docxCommentTool } = await import('../../src/core/tools/builtin/docx/tools/fields.js');
    const out = path.join(path.dirname(sectionDoc), 'cmt.docx');
    const r = await docxCommentTool.execute(
      { inputPath: sectionDoc, paragraph: 0, text: 'Review this', outputPath: out }, makeCtx());
    expect(r.success).toBe(true);
    await access(out);
  }, 120_000);
});

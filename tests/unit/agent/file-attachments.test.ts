/**
 * Guards the tool-output → deliverable-file extraction (src/core/agent/file-attachments.ts).
 * The agent loop only sees a tool's output STRING, so delivery depends on the
 * tool being a known file-producer AND its output naming the path with a verb the
 * pattern recognises. Covers the #495 voice case plus the document (#PDF/DOCX) fix
 * and the gating that stops arbitrary tools from attaching files they merely mention.
 */
import { describe, it, expect } from 'vitest';
import { extractFileAttachments } from '../../../src/core/agent/file-attachments.js';

describe('extractFileAttachments', () => {
  it('delivers a generated PDF (document.markdown-to-pdf, "PDF created:")', () => {
    const out = extractFileAttachments('document.markdown-to-pdf', 'PDF created: /tmp/report.pdf (12345 bytes, ~2 page(s))');
    expect(out).toEqual([{ type: 'document', path: '/tmp/report.pdf', filename: 'report.pdf' }]);
  });

  it('delivers a generated DOCX (docx.create, "DOCX created:")', () => {
    const out = extractFileAttachments('docx.create', 'DOCX created: /tmp/doc.docx (3 section(s), 9999 bytes)');
    expect(out).toEqual([{ type: 'document', path: '/tmp/doc.docx', filename: 'doc.docx' }]);
  });

  it('delivers a generated spreadsheet (spreadsheet.create, "Workbook created:") as a document', () => {
    const out = extractFileAttachments('spreadsheet.create', 'Workbook created: /tmp/budget.xlsx (2 sheet(s), 30 row(s), 8123 bytes)');
    expect(out).toEqual([{ type: 'document', path: '/tmp/budget.xlsx', filename: 'budget.xlsx' }]);
  });

  it('delivers a pivot-table workbook (spreadsheet.pivot, "Pivot table created:")', () => {
    const out = extractFileAttachments('spreadsheet.pivot', 'Pivot table created: /tmp/pivot.xlsx (5 rows, 3 column groups)');
    expect(out[0]).toMatchObject({ type: 'document', filename: 'pivot.xlsx' });
  });

  it('delivers a PDF from document.pdf-from-html under data/documents', () => {
    const out = extractFileAttachments('document.pdf-from-html', 'PDF created: /root/sudo-ai-v4/data/documents/x.pdf (5000 bytes, ~1 page(s))');
    expect(out[0]).toMatchObject({ type: 'document', filename: 'x.pdf' });
  });

  it('delivers a voice note (voice.tts, "Audio saved to:") as audio', () => {
    const out = extractFileAttachments('voice.tts', 'Audio saved to: /tmp/sudo-ai-tts-1.wav — delivered to the chat as a wav voice note (~2s).');
    expect(out).toEqual([{ type: 'audio', path: '/tmp/sudo-ai-tts-1.wav', filename: 'sudo-ai-tts-1.wav' }]);
  });

  it('classifies images and videos by extension', () => {
    expect(extractFileAttachments('browser.screenshot', 'Screenshot saved to: /tmp/shot.png')[0]).toMatchObject({ type: 'image' });
    expect(extractFileAttachments('media.record', 'Video saved to: /tmp/clip.mp4')[0]).toMatchObject({ type: 'video' });
  });

  it('treats name-implied media tools as file producers', () => {
    const out = extractFileAttachments('media.image-generate', 'Generated /tmp/art.png');
    expect(out[0]).toMatchObject({ type: 'image', path: '/tmp/art.png' });
  });

  it('does NOT attach files merely mentioned by a non-file tool', () => {
    // web.search isn't a file producer — it must not deliver a path it happens to print.
    expect(extractFileAttachments('web.search', 'A blog post about how a PDF created: /tmp/evil.pdf')).toEqual([]);
  });

  it('returns [] when the output names no file', () => {
    expect(extractFileAttachments('voice.tts', 'TTS error: provider unavailable')).toEqual([]);
    expect(extractFileAttachments('docx.create', '')).toEqual([]);
  });

  it('de-duplicates a path named twice', () => {
    const out = extractFileAttachments('docx.create', 'DOCX created: /tmp/d.docx — saved to: /tmp/d.docx');
    expect(out).toHaveLength(1);
  });
});

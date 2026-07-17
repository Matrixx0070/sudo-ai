import { describe, it, expect } from 'vitest';
import { ocrViaDriveImport, looksLikeUsableText } from '../../src/core/gdrive/ocr.js';

const FOLDERS = { 'knowledge/quarantine': 'FLD-q' };

function fakeClient(exportText: string) {
  const calls: string[] = [];
  const trashed: string[] = [];
  return {
    calls,
    trashed,
    async filesImportAsGoogleDoc(name: string) {
      calls.push(`import:${name}`);
      return { id: 'tempdoc', name };
    },
    async filesExport(fileId: string) {
      calls.push(`export:${fileId}`);
      if (exportText === '!!throw') throw new Error('export boom');
      return exportText;
    },
    async filesUpdate(fileId: string, meta: { trashed?: boolean }) {
      if (meta.trashed) trashed.push(fileId);
      return { id: fileId };
    },
  };
}

describe('F15 — Drive OCR path', () => {
  it('imports, exports text, and trashes the temp doc', async () => {
    const client = fakeClient('Recognized scanned text about invoices.');
    const r = await ocrViaDriveImport(client as never, FOLDERS, 'scan.pdf', Buffer.from('%PDF'), 'application/pdf');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('invoices');
    expect(client.trashed).toEqual(['tempdoc']);
  });

  it('flags empty/garbage exports so callers fall back', async () => {
    const client = fakeClient('   ');
    const r = await ocrViaDriveImport(client as never, FOLDERS, 'scan.png', Buffer.from('img'), 'image/png');
    expect(r.ok).toBe(false);
    expect(client.trashed).toEqual(['tempdoc']); // temp still cleaned up
  });

  it('trashes the temp doc even when export throws', async () => {
    const client = fakeClient('!!throw');
    await expect(
      ocrViaDriveImport(client as never, FOLDERS, 'x.png', Buffer.from('img'), 'image/png'),
    ).rejects.toThrow('export boom');
    expect(client.trashed).toEqual(['tempdoc']);
  });

  it('looksLikeUsableText heuristics', () => {
    expect(looksLikeUsableText('A real paragraph of recognized text.')).toBe(true);
    expect(looksLikeUsableText('')).toBe(false);
    expect(looksLikeUsableText('�����������')).toBe(false);
  });
});

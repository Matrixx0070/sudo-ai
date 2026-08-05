/**
 * @file magika.test.ts
 * @description Magika content-type detection. Always-run: empty handling + label
 * space (no model load). Gated behind RUN_MAGIKA=1: real ONNX classification
 * (the model is vendored, so this needs no network — just opt-in for speed).
 */
import { describe, it, expect } from 'vitest';
import { detectContentType, magikaLabels } from '../../src/core/files/magika/magika.js';

describe('magika — always run (no model load)', () => {
  it('empty input classifies as `empty` without loading the model', async () => {
    const r = await detectContentType(Buffer.alloc(0));
    expect(r.label).toBe('empty');
    expect(r.score).toBe(1);
  });

  it('exposes the 214-label space', () => {
    const labels = magikaLabels();
    expect(labels.length).toBe(214);
    expect(labels).toContain('python');
    expect(labels).toContain('json');
    expect(labels).toContain('pdf');
  });
});

const realModel = process.env['RUN_MAGIKA'] === '1' ? describe : describe.skip;

realModel('magika — real ONNX model (RUN_MAGIKA=1)', () => {
  const py = Buffer.from('import os\nimport sys\n\ndef main():\n    print(sys.argv)\n\nif __name__ == "__main__":\n    main()\n');
  const json = Buffer.from('{\n  "name": "example",\n  "version": "1.0.0",\n  "items": [1, 2, 3]\n}\n');
  const md = Buffer.from('# Title\n\nSome **markdown** with a [link](https://example.com).\n\n- a\n- b\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

  it('classifies python source', async () => {
    const r = await detectContentType(py);
    expect(r.label).toBe('python');
    expect(r.group).toBe('code');
    expect(r.isText).toBe(true);
    expect(r.score).toBeGreaterThan(0.5);
  });

  it('classifies json (code group)', async () => {
    const r = await detectContentType(json);
    expect(r.label).toBe('json');
    expect(r.mimeType).toBe('application/json');
  });

  it('classifies markdown as text', async () => {
    const r = await detectContentType(md);
    expect(r.label).toBe('markdown');
    expect(r.isText).toBe(true);
  });

  it('classifies a PNG header as a non-text image/binary', async () => {
    const r = await detectContentType(png);
    expect(r.isText).toBe(false);
    // Magika recognises png even from the header bytes.
    expect(['png', 'unknown']).toContain(r.label);
  });
});

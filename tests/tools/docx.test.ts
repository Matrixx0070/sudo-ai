/**
 * @file docx.test.ts
 * @description Test suite for docx.* tools (Wave 9B2).
 * Tests: docx.create — 6 tests total.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

const TMP = os.tmpdir();

// ---------------------------------------------------------------------------
// docx.create
// ---------------------------------------------------------------------------

describe('docx.create', () => {
  it('1. rejects missing outputPath', async () => {
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const result = await docxCreateTool.execute(
      { title: 'Test', sections: [{ paragraphs: ['hello'] }] },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('outputPath');
  });

  it('2. rejects outputPath outside allowed dirs', async () => {
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const result = await docxCreateTool.execute(
      {
        outputPath: '/etc/bad.docx',
        title: 'Test',
        sections: [{ paragraphs: ['hello'] }],
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('outputPath must be');
  });

  it('3. rejects missing title', async () => {
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const result = await docxCreateTool.execute(
      {
        outputPath: path.join(TMP, 'test.docx'),
        sections: [{ paragraphs: ['hello'] }],
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('title');
  });

  it('4. rejects empty sections', async () => {
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const result = await docxCreateTool.execute(
      {
        outputPath: path.join(TMP, 'test.docx'),
        title: 'Test',
        sections: [],
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('sections');
  });

  it('5. creates valid DOCX file and returns metadata', async () => {
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const outPath = path.join(TMP, `docx-create-${Date.now()}.docx`);

    const result = await docxCreateTool.execute(
      {
        outputPath: outPath,
        title: 'Q1 Sales Report',
        sections: [
          {
            heading: 'Executive Summary',
            paragraphs: [
              'Q1 revenue reached $88,000 across both regions.',
              'North region led with $50,000; South followed with $38,000.',
            ],
          },
          {
            heading: 'Recommendations',
            paragraphs: ['Invest in South region marketing.'],
          },
        ],
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['path']).toBe(outPath);
    expect(typeof data['sizeBytes']).toBe('number');
    expect((data['sizeBytes'] as number)).toBeGreaterThan(0);
    expect(data['sectionCount']).toBe(2);
    expect(existsSync(outPath)).toBe(true);
  });

  it('6. creates DOCX without section headings (paragraphs-only sections)', async () => {
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const outPath = path.join(TMP, `docx-noheading-${Date.now()}.docx`);

    const result = await docxCreateTool.execute(
      {
        outputPath: outPath,
        title: 'Simple Document',
        sections: [
          { paragraphs: ['First paragraph without a heading.', 'Second paragraph.'] },
        ],
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(existsSync(outPath)).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['sectionCount']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('docx tool registration', () => {
  it('7. registerDocxTools registers docx.create', async () => {
    const { registerDocxTools } = await import('../../src/core/tools/builtin/docx/index.js');
    const registered: string[] = [];
    const mockRegistry = {
      register: (tool: { name: string }) => { registered.push(tool.name); },
    };
    registerDocxTools(mockRegistry as never);
    expect(registered).toContain('docx.create');
    expect(registered.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Richer formatting (2026-07-31): bullets + tables, backwards compatible
// ---------------------------------------------------------------------------

describe('docx.create — richer formatting', () => {
  it('8. renders real Word bullets and a real table, and keeps paragraphs-only working', async () => {
    const { execFileSync } = await import('node:child_process');
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const { rmSync } = await import('node:fs');

    // paragraphs-only (the pre-existing contract) still succeeds
    const legacyPath = path.join(TMP, `docx-legacy-${process.pid}.docx`);
    const legacy = await docxCreateTool.execute(
      { outputPath: legacyPath, title: 'Legacy', sections: [{ heading: 'S', paragraphs: ['plain'] }] },
      makeCtx(),
    );
    expect(legacy.success).toBe(true);

    const richPath = path.join(TMP, `docx-rich-${process.pid}.docx`);
    const rich = await docxCreateTool.execute(
      {
        outputPath: richPath,
        title: 'Release Review',
        sections: [
          { heading: 'Highlights', paragraphs: ['Speed focus.'], bullets: ['Fast mode', 'Local embeddings'] },
          { heading: 'Metrics', table: { headers: ['Metric', 'After'], rows: [['tok/s', '127.6']] } },
        ],
      },
      makeCtx(),
    );
    expect(rich.success).toBe(true);
    expect(existsSync(richPath)).toBe(true);

    // Inspect the OOXML: w:tbl = real table, numPr = real bullet numbering.
    let xml = '';
    try {
      xml = execFileSync('unzip', ['-p', richPath, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 8e6 });
    } catch {
      xml = '';
    }
    if (xml !== '') {
      expect(xml).toContain('<w:tbl>');
      expect(xml).toContain('numPr');
      expect(xml).toContain('127.6');
    }

    for (const f of [legacyPath, richPath]) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
  });

  it('9. a section with only bullets (no paragraphs) is valid', async () => {
    const { rmSync } = await import('node:fs');
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const out = path.join(TMP, `docx-bullets-${process.pid}.docx`);
    const r = await docxCreateTool.execute(
      { outputPath: out, title: 'Bullets', sections: [{ heading: 'Only bullets', bullets: ['one', 'two'] }] },
      makeCtx(),
    );
    expect(r.success).toBe(true);
    try { rmSync(out, { force: true }); } catch { /* ignore */ }
  });

  it('10. a section with none of paragraphs/bullets/table is still rejected', async () => {
    const { docxCreateTool } = await import('../../src/core/tools/builtin/docx/tools/create.js');
    const r = await docxCreateTool.execute(
      { outputPath: path.join(TMP, 'docx-empty.docx'), title: 'T', sections: [{ heading: 'nothing' }] },
      makeCtx(),
    );
    expect(r.success).toBe(false);
    expect(r.output).toContain('at least one');
  });
});

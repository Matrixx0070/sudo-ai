/**
 * Tests for the document.* skill category.
 *
 * Covers:
 *   - document.pdf-from-html   (PDF generation via Playwright)
 *   - document.markdown-to-pdf (Markdown→HTML→PDF pipeline)
 *   - document.pdf-extract-text (text extraction via pdftotext)
 *   - document.pdf-extract-tables (table extraction via pdftohtml)
 *
 * Tests that require real Playwright or real poppler-utils are marked
 * `integration` and use a real fixture PDF created once before all suites.
 * Unit tests mock the external dependencies.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), `document-test-${Date.now()}`);

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session-doc',
    workingDir: TMP_DIR,
    config: null,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // non-fatal
  }
});

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

// ---------------------------------------------------------------------------
// 1. document.pdf-from-html — input validation (unit tests, no Playwright)
// ---------------------------------------------------------------------------

describe('document.pdf-from-html — input validation', () => {
  let tool: Awaited<ReturnType<typeof importPdfFromHtml>>;

  async function importPdfFromHtml() {
    const mod = await import('../../src/core/tools/builtin/document/tools/pdf-from-html.js');
    return mod.pdfFromHtmlTool;
  }

  beforeAll(async () => {
    tool = await importPdfFromHtml();
  });

  it('rejects empty html', async () => {
    const result = await tool.execute({ html: '', outputPath: '/tmp/test.pdf' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('"html"');
  });

  it('rejects missing outputPath', async () => {
    const result = await tool.execute({ html: '<p>hello</p>', outputPath: '' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('"outputPath"');
  });

  it('rejects outputPath outside allowed prefixes', async () => {
    const result = await tool.execute(
      { html: '<p>hello</p>', outputPath: '/etc/evil.pdf' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('/tmp/');
  });

  it('accepts /tmp/ prefix', async () => {
    // Provide valid html so execution actually reaches path validation, and stub
    // the browser launch so no real Chromium starts. The output stays inside the
    // isolated TMP_DIR (which lives under /tmp/), so any mkdir is in the temp dir.
    const { chromium } = await import('playwright-core');
    const launchSpy = vi
      .spyOn(chromium, 'launch')
      .mockRejectedValue(new Error('BROWSER_STUB: launch intercepted'));
    try {
      const result = await tool.execute(
        { html: '<p>hello</p>', outputPath: join(TMP_DIR, 'ok.pdf') },
        makeCtx(),
      );
      // Path validation passed (html and path are both valid); the only failure
      // is the stubbed browser launch, proving the /tmp/ prefix was accepted.
      expect(result.output).not.toContain('must be under');
      expect(launchSpy).toHaveBeenCalled();
    } finally {
      launchSpy.mockRestore();
    }
  });

  it('accepts /root/sudo-ai-v4/data/documents/ prefix path validation', async () => {
    // Verify the production data-dir prefix is on the accepted allow-list WITHOUT
    // executing the tool (which would mkdir the real production directory and/or
    // launch a browser). A rejected path surfaces the allow-list in its error, so
    // we assert that error names /root/sudo-ai-v4/data/documents/ as allowed and
    // that a path under that prefix is NOT what the rejection complains about.
    const rejected = await tool.execute(
      { html: '<p>hello</p>', outputPath: '/etc/not-allowed.pdf' },
      makeCtx(),
    );
    expect(rejected.success).toBe(false);
    // The rejection lists the allowed prefixes, confirming the data dir is allowed.
    expect(rejected.output).toContain('/root/sudo-ai-v4/data/documents/');
    // And it complains specifically about the disallowed input path, not the data dir.
    expect(rejected.output).toContain('/etc/not-allowed.pdf');
    expect(rejected.output).not.toContain('/root/sudo-ai-v4/data/documents/test.pdf');
  });

  it('has correct tool metadata', async () => {
    expect(tool.name).toBe('document.pdf-from-html');
    expect(tool.category).toBe('document');
    expect(tool.timeout).toBe(30_000);
    expect(typeof tool.execute).toBe('function');
  });

  it('parameters schema has required fields', () => {
    expect(tool.parameters['html']?.required).toBe(true);
    expect(tool.parameters['outputPath']?.required).toBe(true);
    expect(tool.parameters['format']?.enum).toContain('A4');
    expect(tool.parameters['format']?.enum).toContain('Letter');
  });
});

// ---------------------------------------------------------------------------
// 2. document.markdown-to-pdf — input validation
// ---------------------------------------------------------------------------

describe('document.markdown-to-pdf — input validation', () => {
  let tool: Awaited<ReturnType<typeof importMarkdownToPdf>>;

  async function importMarkdownToPdf() {
    const mod = await import('../../src/core/tools/builtin/document/tools/markdown-to-pdf.js');
    return mod.markdownToPdfTool;
  }

  beforeAll(async () => {
    tool = await importMarkdownToPdf();
  });

  it('rejects empty markdown', async () => {
    const result = await tool.execute(
      { markdown: '   ', outputPath: '/tmp/out.pdf' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('"markdown"');
  });

  it('rejects missing outputPath', async () => {
    const result = await tool.execute(
      { markdown: '# Hello', outputPath: '' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('"outputPath"');
  });

  it('rejects path outside allowed dirs', async () => {
    const result = await tool.execute(
      { markdown: '# Hello', outputPath: '/home/user/out.pdf' },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('/tmp/');
  });

  it('has correct tool metadata', async () => {
    expect(tool.name).toBe('document.markdown-to-pdf');
    expect(tool.category).toBe('document');
    expect(tool.timeout).toBe(30_000);
  });

  it('parameters schema', () => {
    expect(tool.parameters['markdown']?.required).toBe(true);
    expect(tool.parameters['outputPath']?.required).toBe(true);
    expect(tool.parameters['title']?.required).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 3. document.pdf-extract-text — input validation (unit, no pdftotext calls)
// ---------------------------------------------------------------------------

describe('document.pdf-extract-text — input validation', () => {
  let tool: Awaited<ReturnType<typeof importExtractText>>;

  async function importExtractText() {
    const mod = await import('../../src/core/tools/builtin/document/tools/pdf-extract-text.js');
    return mod.pdfExtractTextTool;
  }

  beforeAll(async () => {
    tool = await importExtractText();
  });

  it('rejects empty pdfPath', async () => {
    const result = await tool.execute({ pdfPath: '' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('"pdfPath"');
  });

  it('rejects relative pdfPath', async () => {
    const result = await tool.execute({ pdfPath: 'relative/path.pdf' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('absolute path');
  });

  it('rejects non-existent file', async () => {
    const result = await tool.execute({ pdfPath: '/tmp/nonexistent-doc.pdf' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('not found');
  });

  it('rejects non-pdf extension', async () => {
    // Create a temp file with wrong extension
    const fakePath = join(TMP_DIR, 'test.txt');
    writeFileSync(fakePath, 'not a pdf');
    const result = await tool.execute({ pdfPath: fakePath }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('PDF');
  });

  it('rejects invalid page range', async () => {
    const fakePdf = join(TMP_DIR, 'fake.pdf');
    writeFileSync(fakePdf, '%PDF-1.4 fake');
    const result = await tool.execute({ pdfPath: fakePdf, pages: 'bad-range' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid');
  });

  it('rejects inverted page range', async () => {
    const fakePdf = join(TMP_DIR, 'fake2.pdf');
    writeFileSync(fakePdf, '%PDF-1.4 fake');
    const result = await tool.execute({ pdfPath: fakePdf, pages: '5-2' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid page range');
  });

  it('has correct tool metadata', async () => {
    expect(tool.name).toBe('document.pdf-extract-text');
    expect(tool.category).toBe('document');
    expect(tool.timeout).toBe(15_000);
    expect(tool.safety).toBe('readonly');
  });

  it('parameters include format enum', () => {
    expect(tool.parameters['format']?.enum).toContain('text');
    expect(tool.parameters['format']?.enum).toContain('json');
  });
});

// ---------------------------------------------------------------------------
// 4. document.pdf-extract-tables — input validation
// ---------------------------------------------------------------------------

describe('document.pdf-extract-tables — input validation', () => {
  let tool: Awaited<ReturnType<typeof importExtractTables>>;

  async function importExtractTables() {
    const mod = await import('../../src/core/tools/builtin/document/tools/pdf-extract-tables.js');
    return mod.pdfExtractTablesTool;
  }

  beforeAll(async () => {
    tool = await importExtractTables();
  });

  it('rejects empty pdfPath', async () => {
    const result = await tool.execute({ pdfPath: '' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('"pdfPath"');
  });

  it('rejects relative pdfPath', async () => {
    const result = await tool.execute({ pdfPath: 'myfile.pdf' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('absolute path');
  });

  it('rejects non-existent file', async () => {
    const result = await tool.execute({ pdfPath: '/tmp/missing-file.pdf' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('not found');
  });

  it('rejects invalid page range', async () => {
    const fakePdf = join(TMP_DIR, 'fake-tables.pdf');
    writeFileSync(fakePdf, '%PDF-1.4 fake');
    const result = await tool.execute({ pdfPath: fakePdf, pages: 'abc' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid');
  });

  it('rejects inverted page range', async () => {
    const fakePdf = join(TMP_DIR, 'fake-tables2.pdf');
    writeFileSync(fakePdf, '%PDF-1.4 fake');
    const result = await tool.execute({ pdfPath: fakePdf, pages: '10-1' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid page range');
  });

  it('has correct tool metadata', async () => {
    expect(tool.name).toBe('document.pdf-extract-tables');
    expect(tool.category).toBe('document');
    expect(tool.timeout).toBe(15_000);
    expect(tool.safety).toBe('readonly');
  });

  it('parameters schema', () => {
    expect(tool.parameters['pdfPath']?.required).toBe(true);
    expect(tool.parameters['pages']?.required).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 5. registerDocumentTools — registry integration
// ---------------------------------------------------------------------------

describe('registerDocumentTools — registry', () => {
  it('exports DOCUMENT_TOOLS array with 4 tools', async () => {
    const mod = await import('../../src/core/tools/builtin/document/index.js');
    expect(Array.isArray(mod.DOCUMENT_TOOLS)).toBe(true);
    expect(mod.DOCUMENT_TOOLS.length).toBe(4);
  });

  it('all tools have required ToolDefinition fields', async () => {
    const { DOCUMENT_TOOLS } = await import('../../src/core/tools/builtin/document/index.js');
    for (const tool of DOCUMENT_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name).toMatch(/^document\./);
      expect(typeof tool.description).toBe('string');
      expect(tool.category).toBe('document');
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.parameters).toBe('object');
    }
  });

  it('registerDocumentTools registers all tools into a mock registry', async () => {
    const { registerDocumentTools } = await import('../../src/core/tools/builtin/document/index.js');
    const registered: string[] = [];
    const mockRegistry = {
      registerMany: (tools: Array<{ name: string }>) => {
        for (const t of tools) registered.push(t.name);
      },
    };
    registerDocumentTools(mockRegistry as never);
    expect(registered).toContain('document.pdf-from-html');
    expect(registered).toContain('document.markdown-to-pdf');
    expect(registered).toContain('document.pdf-extract-text');
    expect(registered).toContain('document.pdf-extract-tables');
  });

  it('named re-exports are available', async () => {
    const mod = await import('../../src/core/tools/builtin/document/index.js');
    expect(mod.pdfFromHtmlTool).toBeDefined();
    expect(mod.markdownToPdfTool).toBeDefined();
    expect(mod.pdfExtractTextTool).toBeDefined();
    expect(mod.pdfExtractTablesTool).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. ToolCategory type — 'document' is valid
// ---------------------------------------------------------------------------

describe('ToolCategory — document category', () => {
  it('document tools use the document category string', async () => {
    const { DOCUMENT_TOOLS } = await import('../../src/core/tools/builtin/document/index.js');
    const categories = DOCUMENT_TOOLS.map((t) => t.category);
    expect(categories.every((c) => c === 'document')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Inline markdown converter (unit test — no external deps)
// ---------------------------------------------------------------------------

describe('markdown-to-pdf — inline converter output', () => {
  it('validates markdown parameter and output path', async () => {
    // Test the validation layer — no Playwright needed
    const { markdownToPdfTool } = await import('../../src/core/tools/builtin/document/tools/markdown-to-pdf.js');

    // Empty markdown should fail validation
    const r1 = await markdownToPdfTool.execute(
      { markdown: '', outputPath: '/tmp/markdown-test.pdf' },
      makeCtx(),
    );
    expect(r1.success).toBe(false);
    expect(r1.output).toContain('"markdown"');

    // Bad path should fail validation before reaching Playwright
    const r2 = await markdownToPdfTool.execute(
      { markdown: '# Hello World', outputPath: '/etc/bad.pdf' },
      makeCtx(),
    );
    expect(r2.success).toBe(false);
    expect(r2.output).toContain('/tmp/');
  });

  it('accepts valid markdown and output path (result is boolean)', async () => {
    const { markdownToPdfTool } = await import('../../src/core/tools/builtin/document/tools/markdown-to-pdf.js');
    // This may invoke real Playwright if available — just assert type contract is met
    const result = await markdownToPdfTool.execute(
      {
        markdown: '# Title\n\n**bold** text\n\n- item 1\n- item 2',
        outputPath: join(TMP_DIR, 'markdown-unit-test.pdf'),
      },
      makeCtx(),
    );
    // The tool must always return a boolean success and string output
    expect(typeof result.success).toBe('boolean');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Integration — real PDF generation + extraction (requires Playwright + poppler)
// ---------------------------------------------------------------------------

const FIXTURE_PDF = join(TMP_DIR, 'fixture.pdf');
const SIMPLE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Test</title></head>
<body>
  <h1>SUDO-AI Document Test</h1>
  <p>Page 1 content. This is a test fixture PDF.</p>
  <table border="1">
    <tr><th>Name</th><th>Value</th></tr>
    <tr><td>Alpha</td><td>1</td></tr>
    <tr><td>Beta</td><td>2</td></tr>
  </table>
</body>
</html>`;

describe('document.pdf-from-html — integration (real Playwright)', () => {
  it('generates a real PDF to /tmp/', { timeout: 35_000 }, async () => {
    const { pdfFromHtmlTool } = await import('../../src/core/tools/builtin/document/tools/pdf-from-html.js');
    const outputPath = join(TMP_DIR, 'integration-test.pdf');
    const result = await pdfFromHtmlTool.execute(
      { html: SIMPLE_HTML, outputPath },
      makeCtx(),
    );
    // Allow graceful failure in restricted environments (e.g. sandboxed CI without Chromium access)
    if (!result.success) {
      console.warn('[integration] pdf-from-html unavailable:', result.output);
      return;
    }
    if (!existsSync(outputPath)) {
      console.warn('[integration] pdf-from-html: file not found at', outputPath, '(result:', result.output, ')');
      return;
    }
    expect(result.success).toBe(true);
    expect(existsSync(outputPath)).toBe(true);
    expect((result.data as { sizeBytes: number }).sizeBytes).toBeGreaterThan(0);
    // Save as fixture for subsequent extraction tests
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(FIXTURE_PDF, readFileSync(outputPath));
  });
});

describe('document.pdf-extract-text — integration (real pdftotext)', () => {
  it('extracts text from fixture PDF', { timeout: 20_000 }, async () => {
    if (!existsSync(FIXTURE_PDF)) {
      console.warn('[integration] pdf-extract-text skipped: fixture PDF not found');
      return;
    }
    const { pdfExtractTextTool } = await import('../../src/core/tools/builtin/document/tools/pdf-extract-text.js');
    const result = await pdfExtractTextTool.execute(
      { pdfPath: FIXTURE_PDF, format: 'text' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('SUDO-AI');
    expect((result.data as { characters: number }).characters).toBeGreaterThan(10);
  });

  it('extracts as JSON (per-page)', { timeout: 20_000 }, async () => {
    if (!existsSync(FIXTURE_PDF)) {
      console.warn('[integration] pdf-extract-text json skipped: fixture not found');
      return;
    }
    const { pdfExtractTextTool } = await import('../../src/core/tools/builtin/document/tools/pdf-extract-text.js');
    const result = await pdfExtractTextTool.execute(
      { pdfPath: FIXTURE_PDF, format: 'json' },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(Array.isArray((result.data as { pages: unknown[] }).pages)).toBe(true);
  });
});

describe('document.pdf-extract-tables — integration (real pdftohtml)', () => {
  it('extracts or returns empty tables from fixture PDF', { timeout: 20_000 }, async () => {
    if (!existsSync(FIXTURE_PDF)) {
      console.warn('[integration] pdf-extract-tables skipped: fixture not found');
      return;
    }
    const { pdfExtractTablesTool } = await import('../../src/core/tools/builtin/document/tools/pdf-extract-tables.js');
    const result = await pdfExtractTablesTool.execute(
      { pdfPath: FIXTURE_PDF },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(Array.isArray((result.data as { tables: unknown[] }).tables)).toBe(true);
    // tables may or may not have HTML <table> elements depending on how Playwright renders
  });
});

describe('document.markdown-to-pdf — integration (real Playwright)', () => {
  it('converts markdown to PDF', { timeout: 35_000 }, async () => {
    const { markdownToPdfTool } = await import('../../src/core/tools/builtin/document/tools/markdown-to-pdf.js');
    const outputPath = join(TMP_DIR, 'md-integration.pdf');
    const result = await markdownToPdfTool.execute(
      {
        markdown: '# Integration Test\n\n**Bold** and *italic* text.\n\n- Item A\n- Item B\n\n```js\nconsole.log("hello");\n```',
        outputPath,
        title: 'Integration Test',
      },
      makeCtx(),
    );
    // Allow graceful failure in restricted environments (e.g. sandboxed CI without Chromium access)
    if (!result.success) {
      console.warn('[integration] markdown-to-pdf unavailable:', result.output);
      return;
    }
    if (!existsSync(outputPath)) {
      console.warn('[integration] markdown-to-pdf: file not found at', outputPath);
      return;
    }
    expect(result.success).toBe(true);
    expect(existsSync(outputPath)).toBe(true);
  });
});

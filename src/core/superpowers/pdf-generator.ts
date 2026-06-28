/**
 * super.generate-pdf — Generate a PDF from markdown or HTML content.
 *
 * Converts markdown to HTML, renders it in a headless Playwright browser,
 * and prints to PDF at the specified output path.
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../tools/types.js';

const logger = createLogger('super.generate-pdf');

// ---------------------------------------------------------------------------
// Markdown to HTML
// ---------------------------------------------------------------------------

function markdownToHtml(md: string, title: string): string {
  let html = md
    .replace(/^#{6}\s+(.+)/gm, '<h6>$1</h6>')
    .replace(/^#{5}\s+(.+)/gm, '<h5>$1</h5>')
    .replace(/^#{4}\s+(.+)/gm, '<h4>$1</h4>')
    .replace(/^#{3}\s+(.+)/gm, '<h3>$1</h3>')
    .replace(/^#{2}\s+(.+)/gm, '<h2>$1</h2>')
    .replace(/^#{1}\s+(.+)/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^[-*]\s+(.+)/gm, '<li>$1</li>')
    .replace(/^\d+\.\s+(.+)/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { font-family: Georgia, serif; font-size: 14px; line-height: 1.7; max-width: 800px; margin: 40px auto; color: #222; }
    h1,h2,h3,h4,h5,h6 { font-family: Arial, sans-serif; color: #111; margin-top: 1.5em; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    a { color: #0055cc; }
    li { margin-bottom: 4px; }
    p { margin: 0.8em 0; }
    pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <p>${html}</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const pdfGeneratorTool: ToolDefinition = {
  name: 'super.generate-pdf',
  description: 'Convert markdown or HTML content to a PDF file using Playwright headless browser rendering.',
  category: 'superpowers',
  timeout: 60_000,
  parameters: {
    content: { type: 'string', description: 'Markdown or HTML string to render as PDF.', required: true },
    outputPath: { type: 'string', description: 'Absolute path where the PDF will be saved.', required: true },
    title: { type: 'string', description: 'Document title shown in the PDF header.', default: 'Document' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content = params['content'] as string | undefined;
    const outputPath = params['outputPath'] as string | undefined;
    const title = (params['title'] as string | undefined) ?? 'Document';

    if (!content || typeof content !== 'string') return { success: false, output: 'content is required.' };
    if (!outputPath) return { success: false, output: 'outputPath is required.' };

    logger.info({ session: ctx.sessionId, outputPath, title }, 'Generating PDF');

    await mkdir(dirname(outputPath), { recursive: true });

    const isHtml = content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html');
    const htmlContent = isHtml ? content : markdownToHtml(content, title);

    // Write temp HTML file
    const tmpFile = join(dirname(outputPath), `.tmp_pdf_${randomBytes(8).toString('hex')}.html`);

    let browser: Awaited<ReturnType<typeof import('playwright-core')['chromium']['launch']>> | undefined;
    try {
      await writeFile(tmpFile, htmlContent, 'utf8');

      // Dynamically import playwright-core (installed as dependency)
      const { chromium } = await import('playwright-core').catch(() => {
        throw new Error('playwright-core is not installed. Run: pnpm add playwright-core && npx playwright-core install chromium');
      });

      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();

      await page.goto(`file://${tmpFile}`, { waitUntil: 'networkidle' });
      await page.pdf({
        path: outputPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
      });

      logger.info({ outputPath }, 'PDF generated successfully');

      const artifacts: ToolArtifact[] = [{ path: outputPath, action: 'created' }];

      return {
        success: true,
        output: `PDF generated at: ${outputPath}`,
        data: { outputPath, title, isHtml },
        artifacts,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ outputPath, err: msg }, 'PDF generation failed');
      return { success: false, output: `PDF generation failed: ${msg}` };
    } finally {
      await browser?.close().catch(() => { /* non-fatal */ });
      await unlink(tmpFile).catch(() => { /* non-fatal */ });
    }
  },
};

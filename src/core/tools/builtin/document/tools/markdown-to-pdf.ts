/**
 * document.markdown-to-pdf — Convert Markdown to PDF via HTML+Playwright.
 *
 * Checks if the `marked` npm package is installed; uses it if present.
 * Falls back to a built-in inline markdown→HTML converter that handles:
 *   - Headings (#, ##, ###, ####, #####, ######)
 *   - Paragraphs
 *   - Bold (**text**), italic (*text*)
 *   - Inline code (`code`)
 *   - Fenced code blocks (```lang ... ```)
 *   - Unordered lists (- item, * item)
 *   - Ordered lists (1. item)
 *   - Links ([text](url))
 *   - Horizontal rules (---, ***)
 *
 * Delegates PDF emission to the document.pdf-from-html tool logic.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const log = createLogger('document:markdown-to-pdf');

// ---------------------------------------------------------------------------
// Inline markdown→HTML converter (zero-dep fallback)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text: string): string {
  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return text;
}

function markdownToHtml(markdown: string, title = ''): string {
  const lines = markdown.split('\n');
  const htmlLines: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';
  let inParagraph = false;
  const paragraphLines: string[] = [];

  function flushParagraph(): void {
    if (paragraphLines.length > 0) {
      htmlLines.push(`<p>${inlineMarkdown(paragraphLines.join(' '))}</p>`);
      paragraphLines.length = 0;
      inParagraph = false;
    }
  }

  function flushList(): void {
    if (inList) {
      htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }
  }

  for (const raw of lines) {
    const line = raw;

    // Fenced code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        flushParagraph();
        flushList();
        htmlLines.push(
          `<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
        );
        codeLines = [];
        codeLang = '';
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushList();
        codeLang = line.slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Horizontal rules
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      flushList();
      htmlLines.push('<hr>');
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1]!.length;
      const content = inlineMarkdown(escapeHtml(headingMatch[2]!));
      htmlLines.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // Unordered list items
    const ulMatch = /^[\s]*[-*+]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushParagraph();
      if (!inList || listType !== 'ul') {
        flushList();
        htmlLines.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      htmlLines.push(`<li>${inlineMarkdown(escapeHtml(ulMatch[1]!))}</li>`);
      continue;
    }

    // Ordered list items
    const olMatch = /^\d+\.\s+(.+)$/.exec(line);
    if (olMatch) {
      flushParagraph();
      if (!inList || listType !== 'ol') {
        flushList();
        htmlLines.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      htmlLines.push(`<li>${inlineMarkdown(escapeHtml(olMatch[1]!))}</li>`);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    // Regular paragraph text
    flushList();
    paragraphLines.push(escapeHtml(line));
    inParagraph = true;
  }

  flushParagraph();
  flushList();

  if (inCodeBlock && codeLines.length > 0) {
    htmlLines.push(
      `<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
    );
  }

  const titleHtml = title ? `<title>${escapeHtml(title)}</title>` : '<title>Document</title>';
  const body = htmlLines.join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${titleHtml}
<style>
  body { font-family: Georgia, serif; font-size: 12pt; line-height: 1.6; color: #222; margin: 0; padding: 0; }
  h1, h2, h3, h4, h5, h6 { font-family: Arial, sans-serif; margin-top: 1.2em; margin-bottom: 0.4em; }
  h1 { font-size: 2em; border-bottom: 2px solid #333; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #ccc; }
  p { margin: 0.6em 0; }
  code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 0.9em; }
  pre { background: #f4f4f4; padding: 1em; border-radius: 4px; overflow: auto; }
  pre code { background: none; padding: 0; }
  ul, ol { padding-left: 2em; margin: 0.5em 0; }
  li { margin: 0.2em 0; }
  a { color: #0066cc; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1em 0; }
  strong { font-weight: bold; }
  em { font-style: italic; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Try to load marked if installed
// ---------------------------------------------------------------------------

async function markdownToHtmlSafe(markdown: string, title: string): Promise<string> {
  const markedPath = resolve('node_modules/marked/src/marked.js');
  if (existsSync(markedPath)) {
    try {
      // Dynamic import via string variable avoids static analysis of non-installed package
      const markedSpecifier = 'marked';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const markedMod = await (import(/* @vite-ignore */ markedSpecifier) as Promise<any>);
      const markedFn: ((s: string) => string | Promise<string>) =
        typeof markedMod?.marked === 'function' ? markedMod.marked : markedMod?.default ?? markedMod;
      const bodyContent = await Promise.resolve(markedFn(markdown));
      const titleTag = title ? `<title>${escapeHtml(title)}</title>` : '<title>Document</title>';
      return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${titleTag}
<style>body{font-family:Georgia,serif;font-size:12pt;line-height:1.6;color:#222}h1,h2{border-bottom:1px solid #ccc}code{background:#f4f4f4;padding:2px 4px;border-radius:3px}pre{background:#f4f4f4;padding:1em}ul,ol{padding-left:2em}</style>
</head><body>${bodyContent}</body></html>`;
    } catch {
      // Fall through to inline converter
    }
  }
  return markdownToHtml(markdown, title);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const markdownToPdfTool: ToolDefinition = {
  name: 'document.markdown-to-pdf',
  description:
    'Convert a Markdown string to a PDF document. ' +
    'Uses the marked npm package if installed; otherwise uses a built-in converter. ' +
    'Supports headings, paragraphs, bold/italic, code blocks, lists, and links. ' +
    `Output path must be under /tmp/ or ${PROJECT_ROOT}/data/documents/.`,
  category: 'document',
  timeout: 30_000,
  safety: 'readonly',
  parameters: {
    markdown: {
      type: 'string',
      required: true,
      description: 'Markdown content to convert to PDF.',
    },
    outputPath: {
      type: 'string',
      required: true,
      description:
        'Absolute path where the PDF will be saved. Must start with /tmp/ or ' +
        `${PROJECT_ROOT}/data/documents/. Example: /tmp/doc.pdf`,
    },
    title: {
      type: 'string',
      required: false,
      description: 'Optional document title shown in the PDF header.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLog = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const markdown = typeof params['markdown'] === 'string' ? params['markdown'] : '';
    if (!markdown.trim()) {
      return { success: false, output: 'document.markdown-to-pdf: "markdown" must be non-empty.' };
    }

    const rawPath = typeof params['outputPath'] === 'string' ? params['outputPath'].trim() : '';
    if (!rawPath) {
      return { success: false, output: 'document.markdown-to-pdf: "outputPath" is required.' };
    }

    const title = typeof params['title'] === 'string' ? params['title'] : '';

    // Validate output path
    const ALLOWED_PREFIXES = ['/tmp/', `${dataPath('documents')}/`];
    const absPath = rawPath.startsWith('/') ? rawPath : resolve(dataPath('documents'), rawPath);
    const isAllowed = ALLOWED_PREFIXES.some((p) => absPath.startsWith(p));
    if (!isAllowed) {
      return {
        success: false,
        output:
          `document.markdown-to-pdf: outputPath must be under /tmp/ or ` +
          `${PROJECT_ROOT}/data/documents/. Got: "${rawPath}"`,
      };
    }

    let html: string;
    try {
      html = await markdownToHtmlSafe(markdown, title);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `document.markdown-to-pdf: HTML conversion failed: ${msg}` };
    }

    // Delegate to pdf-from-html logic
    mkdirSync(dirname(absPath), { recursive: true });

    const { pdfFromHtmlTool } = await import('./pdf-from-html.js');
    const result = await pdfFromHtmlTool.execute(
      { html, outputPath: absPath },
      ctx,
    );

    if (!result.success) {
      return { success: false, output: `document.markdown-to-pdf: ${result.output}` };
    }

    log.info({ sessionId: ctx.sessionId, outputPath: absPath, title }, 'Markdown converted to PDF');
    ctxLog.info({ tool: 'document.markdown-to-pdf', outputPath: absPath }, 'Markdown PDF created');

    return {
      ...result,
      output: result.output.replace('document.pdf-from-html', 'document.markdown-to-pdf'),
    };
  },
};

export default markdownToPdfTool;

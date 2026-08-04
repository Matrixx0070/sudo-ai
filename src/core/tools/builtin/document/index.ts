/**
 * Document toolkit — registers all document tools into the ToolRegistry.
 *
 * Tools provided:
 *   document.pdf-from-html    — Generate PDF from raw HTML via Playwright Chromium
 *   document.markdown-to-pdf  — Convert Markdown to PDF (HTML intermediate step)
 *   document.pdf-extract-text — Extract text from PDF via pdftotext (poppler-utils)
 *   document.pdf-extract-tables — Extract tables from PDF via pdftohtml (poppler-utils)
 *   document.pdf-form-fields  — Extract fillable form fields as JSON (pypdf)
 *   document.pdf-fill-form    — Fill AcroForm fields or annotate flat forms
 *   document.pdf-to-images    — Render pages as PNGs for visual QA (pdfplumber)
 */

import type { ToolRegistry } from '../../registry.js';
import { pdfFromHtmlTool } from './tools/pdf-from-html.js';
import { markdownToPdfTool } from './tools/markdown-to-pdf.js';
import { pdfExtractTextTool } from './tools/pdf-extract-text.js';
import { pdfExtractTablesTool } from './tools/pdf-extract-tables.js';
import { slidesTool } from './tools/slides.js';
import { webpageTool } from './tools/webpage.js';
import { pdfMergeTool, pdfExtractPagesTool } from './tools/pdf-edit.js';
import { pdfFormFieldsTool, pdfFillFormTool, pdfToImagesTool } from './tools/pdf-forms.js';

/** All document tools in stable registration order. */
export const DOCUMENT_TOOLS = [
  pdfFromHtmlTool,
  markdownToPdfTool,
  pdfExtractTextTool,
  pdfExtractTablesTool,
  slidesTool,
  webpageTool,
  pdfMergeTool,
  pdfExtractPagesTool,
  pdfFormFieldsTool,
  pdfFillFormTool,
  pdfToImagesTool,
] as const;

/**
 * Register all Document tools into the provided registry.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerDocumentTools(registry: ToolRegistry): void {
  registry.registerMany([...DOCUMENT_TOOLS]);
}

// Named re-exports for consumers that import individual tools.
export { pdfFromHtmlTool, markdownToPdfTool, pdfExtractTextTool, pdfExtractTablesTool };

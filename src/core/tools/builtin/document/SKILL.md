---
name: document
description: Generate and extract data from professional documents — PDFs via HTML+Playwright, extraction via poppler-utils. Zero Python deps.
---

# Document Skill

## Routes

| Route | Trigger phrases | Tool |
|---|---|---|
| HTML to PDF | "create PDF", "generate report", "render HTML as PDF", "save this as PDF" | document.pdf-from-html |
| Markdown to PDF | "turn this markdown into PDF", "convert markdown to PDF", "PDF from notes" | document.markdown-to-pdf |
| Extract text | "get text from this PDF", "read the PDF", "extract content from PDF", "parse PDF" | document.pdf-extract-text |
| Extract tables | "pull tables from PDF", "get the tables", "extract table data from PDF" | document.pdf-extract-tables |

## Decision Rules

1. **User has HTML** → use `document.pdf-from-html` directly. Supports A4/Letter, landscape, custom margins.
2. **User has Markdown** → use `document.markdown-to-pdf`. Internally converts Markdown→HTML→PDF.
3. **User wants to read a PDF** → use `document.pdf-extract-text`. Returns full text with layout preservation.
4. **User wants table data from a PDF** → use `document.pdf-extract-tables`. Returns structured rows/cells.
5. **Page range needed** → both extraction tools accept `pages: "1-5"` or `pages: "3"`.
6. **Format preference** → `document.pdf-extract-text` accepts `format: "json"` to return per-page arrays.

## Output Path Rules

PDF creation tools (`pdf-from-html`, `markdown-to-pdf`) save to:
- `/tmp/<filename>.pdf` — for temporary outputs
- `<project-root>/data/documents/<filename>.pdf` — for persistent outputs

Always use an absolute path in the `outputPath` parameter.

## Examples

### Generate a PDF report from HTML

```json
{
  "tool": "document.pdf-from-html",
  "params": {
    "html": "<html><body><h1>Monthly Report</h1><p>Results for Q1...</p></body></html>",
    "outputPath": "/tmp/monthly-report.pdf",
    "format": "A4",
    "landscape": false,
    "margins": { "top": 15, "right": 15, "bottom": 15, "left": 15 }
  }
}
```

### Convert Markdown notes to PDF

```json
{
  "tool": "document.markdown-to-pdf",
  "params": {
    "markdown": "# Meeting Notes\n\n## Action items\n- Follow up with team\n- Send report",
    "outputPath": "/tmp/notes.pdf",
    "title": "Meeting Notes 2026-04-13"
  }
}
```

### Extract all text from a PDF

```json
{
  "tool": "document.pdf-extract-text",
  "params": {
    "pdfPath": "<project-root>/data/documents/report.pdf",
    "format": "text"
  }
}
```

### Extract pages 2-4 as JSON (one entry per page)

```json
{
  "tool": "document.pdf-extract-text",
  "params": {
    "pdfPath": "<project-root>/data/documents/report.pdf",
    "pages": "2-4",
    "format": "json"
  }
}
```

### Extract tables from first page of a PDF

```json
{
  "tool": "document.pdf-extract-tables",
  "params": {
    "pdfPath": "/tmp/financial-data.pdf",
    "pages": "1"
  }
}
```

## Error Cases

| Scenario | Behavior |
|---|---|
| `outputPath` outside `/tmp/` or `data/documents/` | Returns error with instructions |
| PDF file not found | Returns error with path |
| pdftotext/pdftohtml not installed | Returns error with `apt install poppler-utils` hint |
| No tables found in PDF | Returns `tables: []` (not an error) |
| Invalid page range | Returns validation error |
| Playwright/Chromium crash | Cleans up browser, returns error message |
| HTML is empty | Returns validation error before launching browser |

## Dependencies

| Component | Source | Notes |
|---|---|---|
| Playwright Chromium | `playwright-core` npm package | Already installed; browser binary at `~/.cache/ms-playwright/` |
| pdftotext | system `poppler-utils` | `which pdftotext` to verify |
| pdftohtml | system `poppler-utils` | Same package as pdftotext |
| marked (optional) | `marked` npm package | Used if installed; falls back to inline converter |

## Performance

- PDF generation: ~2-5s for simple pages, up to 30s for complex HTML
- Text extraction: <5s for most PDFs (15s timeout)
- Table extraction: <10s for most PDFs (15s timeout)
- All tools clean up resources (browser, temp files) on both success and error

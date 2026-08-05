---
name: pdf
version: 1.0.0
description: PDF task routing and recipes — extract text/tables/images, OCR scans, merge/split/rotate, watermark, passwords, fill forms, generate with reportlab. Condensed from grok's pdf skill; full doc in references/.
author: matrixx0070
tags: [pdf, forms, ocr, reportlab, qpdf]
triggers:
  - fill the pdf
  - fill this pdf
  - fill out the form
  - fill the form
  - pdf form
  - merge the pdfs
  - merge these pdfs
  - combine the pdfs
  - split the pdf
  - rotate the pdf
  - watermark the pdf
  - password protect
  - remove the password
  - ocr this
  - ocr the pdf
  - scanned pdf
  - extract from the pdf
  - extract the tables
  - generate a pdf
  - create a pdf
---

# PDF — task routing + recipes

Deeper material: `skills/pdf/references/FULL_SKILL.md`. Before ANY form
filling: read `src/core/tools/builtin/document/scripts/pdf/forms.md`.

## Route to the right tool first

| Task | Use |
|------|-----|
| Text out | `document.pdf-extract-text` |
| Tables out | `document.pdf-extract-tables` |
| Merge PDFs | `document.pdf-merge` |
| Pull page ranges | `document.pdf-extract-pages` |
| Inspect form fields | `document.pdf-form-fields` |
| Fill a form (fillable or flat) | `document.pdf-fill-form` |
| Pages → PNGs (visual QA) | `document.pdf-to-images` |
| HTML/Markdown → PDF | `document.pdf-from-html` / `document.markdown-to-pdf` |

Fall back to CLI/python below only for what those don't cover.

## CLI recipes (qpdf + poppler, installed)

```bash
# Split: one file per page / a page range
qpdf --split-pages in.pdf out-%d.pdf
qpdf in.pdf --pages . 2-5 -- out.pdf

# Rotate all pages 90° clockwise
qpdf in.pdf out.pdf --rotate=+90

# Passwords: add / remove (needs the password)
qpdf --encrypt "$PW" "$PW" 256 -- in.pdf locked.pdf
qpdf --password="$PW" --decrypt locked.pdf out.pdf

# Embedded images (original bitmaps) vs page screenshots — different things:
pdfimages -all in.pdf img/fig     # original embedded bitmap objects
pdftoppm -png -r 300 in.pdf pg    # rasterized page renders
```

## OCR scanned documents

Extraction returning almost no text on a scan → OCR (tesseract installed):

```python
import pytesseract
from pdf2image import convert_from_path
text = "\n".join(pytesseract.image_to_string(p) for p in convert_from_path("scan.pdf", dpi=300))
```

## Generating with reportlab

- Prefer **Platypus** (story of `Paragraph`/`Table`/`Image`/`Spacer` flowables;
  the engine paginates) for anything document-like; use raw **Canvas** only for
  precise placement.
- **Canvas origin is BOTTOM-LEFT, y grows upward**: "1 inch from the top" is
  `page_height - inch - element_height`.
- Watermark/stamp: render the stamp page with reportlab, merge onto each page
  with pypdf (`page.merge_page(stamp)`).

## Always verify visually

A PDF that "generated without errors" can still be wrong. Render with
`document.pdf-to-images` and READ the pages back (overlaps, clipped text,
missing content) before delivering — mandatory after form fills and
reportlab layouts.

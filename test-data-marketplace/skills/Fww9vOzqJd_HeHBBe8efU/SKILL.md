---
name: pdf-process
description: Extract text, metadata, and page content from PDF files using pdftotext.
trigger: /pdf, extract pdf, read pdf, pdf text, parse pdf, pdf to text, summarize pdf
allowed-tools: [exec.run, filesystem.read]
---

# Skill: PDF Process

## Purpose
Extract readable text and metadata from PDF files using `pdftotext` (from poppler-utils).
Enables the agent to read, summarize, search, and analyze PDF documents.

## When to use
- User provides a PDF file and wants its contents read or summarized
- User wants to search for text within a PDF
- User wants to extract specific pages from a PDF
- User wants metadata (author, title, page count) from a PDF

## How to use

1. Verify `pdftotext` is installed: `exec.run: pdftotext -v`
   If missing: suggest `apt install poppler-utils` (Linux) or `brew install poppler` (macOS).

2. Resolve the PDF file path from `$ARGUMENTS`. If it's a URL, note that the file must be
   downloaded first (use `web.fetch` if available, or inform the user to download it).

3. **Extract all text from a PDF:**
   ```
   pdftotext -layout "<file.pdf>" -
   ```
   The `-` sends output to stdout. The `-layout` flag preserves column structure.

4. **Extract specific pages:**
   ```
   pdftotext -layout -f <first_page> -l <last_page> "<file.pdf>" -
   ```
   Example: pages 1–5: `-f 1 -l 5`

5. **Extract metadata:**
   ```
   pdfinfo "<file.pdf>"
   ```
   Reports: Title, Author, Creator, Pages, Page size, File size, PDF version.

6. **Handle extraction results:**
   - If output is empty, the PDF may be image-based (scanned). Inform the user
     that OCR (e.g., `tesseract`) would be needed.
   - If output is large (>10,000 words), summarize or chunk it before processing.

7. **Search for text in a PDF:**
   - Extract full text, then search with grep or string matching.
   - Report the page number by extracting page-by-page and noting which page matches.

8. Use `filesystem.read` if the extracted text is written to a file for further processing.

## Requirements
- `pdftotext` — part of `poppler-utils` package.
  - Linux: `apt install poppler-utils`
  - macOS: `brew install poppler`
- PDF file must be accessible on the local filesystem.
- Image-based PDFs require OCR tools (e.g., `tesseract`) — not handled by this skill.

## Example
```
/pdf /home/user/report.pdf
/pdf extract pages 1-10 from contract.pdf
/pdf metadata invoice.pdf
/pdf search "total amount" in financial-report.pdf
```

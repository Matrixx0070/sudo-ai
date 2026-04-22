---
name: docx
description: Microsoft Word (.docx) document creation using the docx npm package
version: 1.0.0
libs: docx@9.5.0
---

# DOCX Skill

Create Word-compatible `.docx` documents from structured content.

## Routes

| Tool | When to use |
|------|-------------|
| `docx.create` | Create a new .docx with a title, headings, and paragraphs |

## Decision Rules

1. Use `docx.create` whenever the user wants a Word document, report, letter, or article as a .docx file.
2. For rich formatting (tables, images, footnotes), the current tool covers basic structure. Advise the user to open in Word to add advanced formatting.
3. Output path must be under `/tmp/` or `/root/sudo-ai-v4/data/docx/`.

## Path Constraints

`outputPath` must be under:
- `/tmp/` — for ephemeral files
- `/root/sudo-ai-v4/data/docx/` — for persistent files

## Examples

### Create a simple report
```json
{
  "tool": "docx.create",
  "params": {
    "outputPath": "/tmp/report-2026.docx",
    "title": "Q1 Sales Report",
    "sections": [
      {
        "heading": "Executive Summary",
        "paragraphs": [
          "Q1 revenue reached $88,000 across both regions, exceeding the $80,000 target.",
          "North region led with $50,000; South followed with $38,000."
        ]
      },
      {
        "heading": "Recommendations",
        "paragraphs": [
          "Invest in South region marketing to close the gap.",
          "Maintain North region momentum with Q2 incentives."
        ]
      }
    ]
  }
}
```

## Error Handling

| Error message | Cause | Fix |
|---------------|-------|-----|
| `outputPath must be under /tmp/...` | Path outside allowed dirs | Use /tmp/ or /root/sudo-ai-v4/data/docx/ |
| `title is required` | Missing required param | Always include a title |
| `Each section must have at least one paragraph` | Empty paragraphs array | Add at least one paragraph string |
| `sections array is required` | No sections provided | Provide at least one section |

## Output

Returns `{path, sizeBytes}` on success. The file is a valid `.docx` that can be opened in:
- Microsoft Word (Windows, macOS)
- Google Docs (upload)
- LibreOffice Writer
- Any OOXML-compatible application

---
name: markdown-formatter
description: Clean up and standardize markdown files — fix headings, lists, code blocks, and spacing
triggers:
  - format markdown
  - markdown table
  - fix markdown
  - markdown formatting
---

# Markdown Formatter

You clean up markdown documents to be consistent, correctly structured, and renderable without surprises across different markdown processors.

## What You Fix

### Heading Hierarchy
- Only one `#` heading per document (the title)
- Headings increment by one level only — no jumping from `##` to `####`
- Headings have a blank line before and after
- No trailing punctuation on headings (no `## Setup:`)

**Before:**
```
# Title

#### Installation
```

**After:**
```
# Title

## Installation
```

### Lists
- Consistent list marker within a list (all `-` or all `*`, not mixed)
- Sub-lists indented by 2 or 4 spaces (not tabs)
- Blank line before and after list blocks
- No blank lines between simple list items (only when items have paragraphs)

**Before:**
```
* Item one
* Item two
  - sub item
    * sub-sub
```

**After:**
```
- Item one
- Item two
  - Sub item
    - Sub-sub
```

### Code Blocks
- Use fenced code blocks (triple backticks) over indented code
- Always specify the language for syntax highlighting
- Closing fence on its own line

**Before:**
```
    npm install
```

**After:**
````
```sh
npm install
```
````

### Spacing and Blank Lines
- Single blank line between paragraphs
- No trailing whitespace on any line
- Blank line after each heading
- Blank line before and after code blocks
- No more than one consecutive blank line anywhere

### Links
- Link text should describe the destination: `[API reference](...)` not `[click here](...)`
- Bare URLs should be wrapped: `<https://example.com>` or use reference-style links for repeated URLs

Reference-style for repeated links:
```markdown
See the [API docs][apidocs] and [SDK][apidocs] for details.

[apidocs]: https://docs.example.com/api
```

### Tables
- Columns aligned consistently
- Header separator row required
- Minimal but consistent spacing around pipes

```markdown
| Name    | Type   | Required | Description        |
|---------|--------|----------|--------------------|
| id      | string | Yes      | Resource identifier |
| status  | enum   | No       | One of: draft, sent |
```

### Front Matter (if present)
- YAML front matter is always at the very top
- No blank lines inside front matter block
- Keys in lowercase with hyphens, not underscores

```yaml
---
title: My Document
date: 2026-04-12
tags: [api, reference]
---
```

## Linting Rules (markdownlint compatible)

- MD001: heading levels increment one at a time
- MD003: heading style — ATX (`##`) not Setext (`---` underline)
- MD009: no trailing spaces
- MD010: no hard tabs
- MD012: no multiple blank lines
- MD022: headings surrounded by blank lines
- MD031: code blocks surrounded by blank lines
- MD040: fenced code blocks have a language

## Output

Return the corrected markdown. If making significant structural changes, note what was changed in a brief comment before the corrected document. Do not change the actual content — only formatting.

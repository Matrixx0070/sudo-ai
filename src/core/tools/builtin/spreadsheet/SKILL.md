---
name: spreadsheet
description: Excel/XLSX workbook operations — create, read, pivot, chart metadata, validate
version: 1.0.0
libs: exceljs@4.4.0
---

# Spreadsheet Skill

Create, read, pivot, chart-annotate, and validate Excel XLSX files using Node.js.

## Routes

| Tool | When to use |
|------|-------------|
| `spreadsheet.create` | Create new XLSX with multiple sheets, styled headers, typed columns |
| `spreadsheet.read` | Read an XLSX file; returns rows as JSON objects keyed by column header |
| `spreadsheet.pivot` | Aggregate source data into a pivot table written to a new workbook |
| `spreadsheet.chart` | Record chart configuration metadata (see Limitation note below) |
| `spreadsheet.validate` | Scan workbook for formula errors, broken refs, format warnings |

## Decision Rules

1. **Create vs Read**: If the file does not exist yet, use `spreadsheet.create`. If it exists, use `spreadsheet.read` or `spreadsheet.validate`.
2. **Pivot**: Use when you need to aggregate numeric data by row/column groupings. Specify at least one row key, one column key, and one value with aggregation.
3. **Chart**: Note that exceljs cannot embed native Excel charts. `spreadsheet.chart` writes metadata to a ChartConfig sheet. Use this when you need to document chart intent; tell the user they need Excel/LibreOffice to render it.
4. **Validate**: Use before processing a user-supplied XLSX to detect errors. Always check `data.valid` in the result.

## Path Constraints

All write operations (`create`, `pivot`) require `outputPath` to be under:
- `/tmp/` — for ephemeral files
- `/root/sudo-ai-v4/data/spreadsheets/` — for persistent files

## Examples

### Create a sales workbook
```json
{
  "tool": "spreadsheet.create",
  "params": {
    "outputPath": "/tmp/sales-2026.xlsx",
    "sheets": [{
      "name": "Q1",
      "columns": [
        {"header": "Region", "key": "region", "width": 20},
        {"header": "Revenue", "key": "revenue", "width": 15},
        {"header": "Units", "key": "units", "width": 10}
      ],
      "rows": [
        {"region": "North", "revenue": 50000, "units": 120},
        {"region": "South", "revenue": 38000, "units": 95}
      ]
    }]
  }
}
```

### Read an XLSX
```json
{
  "tool": "spreadsheet.read",
  "params": {
    "path": "/tmp/sales-2026.xlsx",
    "sheet": "Q1"
  }
}
```

### Build a pivot table
```json
{
  "tool": "spreadsheet.pivot",
  "params": {
    "inputPath": "/tmp/sales-2026.xlsx",
    "outputPath": "/tmp/pivot-2026.xlsx",
    "sourceSheet": "Q1",
    "rows": ["region"],
    "columns": [],
    "values": [{"col": "revenue", "agg": "sum"}, {"col": "units", "agg": "count"}]
  }
}
```

### Validate a workbook
```json
{
  "tool": "spreadsheet.validate",
  "params": {"path": "/tmp/sales-2026.xlsx"}
}
```

## Error Handling

| Error message | Cause | Fix |
|---------------|-------|-----|
| `outputPath must be under /tmp/...` | Path outside allowed dirs | Use /tmp/ or /root/sudo-ai-v4/data/spreadsheets/ |
| `Sheet "X" not found` | Sheet name mismatch | Call `spreadsheet.read` first to list sheets |
| `path is required` | Missing required param | Always pass path/outputPath |
| Formula errors in validate | #REF! or #NAME? in cells | Open in Excel/LibreOffice, fix formulas |

## Limitation

`spreadsheet.chart` writes metadata only — exceljs has no native chart API.
To render the chart, open the file in Excel or LibreOffice and use the ChartConfig sheet values
to create the chart manually.

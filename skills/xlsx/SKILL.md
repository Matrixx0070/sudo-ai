---
name: xlsx
version: 1.0.0
description: Spreadsheet deliverable doctrine — formulas not hardcoded values, zero formula errors via recalc, financial-model color/number conventions, template preservation, openpyxl vs pandas routing. Condensed from grok's xlsx skill; full doc in references/.
author: matrixx0070
tags: [xlsx, excel, spreadsheets, financial-models, openpyxl]
triggers:
  - build a spreadsheet
  - create a spreadsheet
  - make a spreadsheet
  - create an excel
  - make an excel
  - excel file
  - excel model
  - financial model
  - update the spreadsheet
  - edit the spreadsheet
  - edit the xlsx
  - fix the spreadsheet
  - spreadsheet formulas
  - pivot table
  - clean this csv
  - analyze this csv
---

# XLSX — deliverable doctrine

Full doc: `skills/xlsx/references/FULL_SKILL.md`. Tools:
`spreadsheet.create/read/pivot/chart/validate` (exceljs) and
**`spreadsheet.recalc`** (LibreOffice — the only thing that actually
evaluates formulas).

## The two iron rules

1. **Use formulas, not hardcoded values.** Never compute in Python/JS and
   write the result into a cell. Write `=SUM(B2:B9)`, `=(C5-B5)/B5`,
   `=AVERAGE(...)` so the workbook stays live when the user edits inputs.
   Hardcoding calculated values is the #1 rejected-deliverable cause.
2. **Zero formula errors.** Every delivered workbook must be run through
   `spreadsheet.recalc` and come back clean — no #REF!, #DIV/0!, #VALUE!,
   #NAME?, #NULL!, #NUM!, #N/A anywhere. `errors_found` = not done: fix and
   re-run. Guard divisions (`=IF(B1=0,0,A1/B1)`) and check ranges after
   inserting/deleting rows.

## Library routing

- **openpyxl** — creating/editing .xlsx with formulas + formatting; loading
  preserves existing formulas/styles. Edit existing files with openpyxl, not
  pandas.
- **pandas** — bulk data analysis in/out (`read_excel`, `to_excel`); loses
  formulas and formatting, so never round-trip a styled workbook through it.
- Reading values only: `load_workbook(path, data_only=True)` returns cached
  results (run `spreadsheet.recalc` first if you just wrote formulas).

## Financial models (unless the user/template says otherwise)

- **Color code text**: BLUE = hardcoded inputs users will change; BLACK =
  formulas/calculations; GREEN = links pulling from other worksheets.
- **Number formats**: right-align numbers; thousands separators; negatives in
  parentheses; currency symbol on first row + totals only; percentages with
  1–2 decimals; consistent decimal places per row/column.
- One consistent professional font (e.g. Arial); years as column headers;
  assumptions clearly separated from outputs.

## Templates override everything

When updating an existing file: study its fonts, colors, number formats, and
formula style FIRST and match them exactly. Never impose the standards above
on a workbook with established conventions.

## Verify before delivering

1. `spreadsheet.recalc` → status must be `success` (zero errors).
2. Re-read computed values (`data_only=True`) and sanity-check magnitudes —
   a formula that evaluates to 0 or 8 digits where you expected 5 is wrong.
3. Spot-check one formula per block by hand.

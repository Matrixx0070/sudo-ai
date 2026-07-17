---
name: bulk-extract
description: Extract the same structured data from many URLs at once using TinyFish batch runs and deliver the combined results as a spreadsheet or CSV. Use when the user has a list of URLs, companies, products, or listings and wants the same fields pulled from each — e.g. "get pricing from these 40 pages", "extract contact info for this list of firms", "turn these listings into a spreadsheet".
---

# Bulk Extract

Fan the same extraction goal out across many URLs, collect the results, and hand back one clean table.

## Pre-flight Check (REQUIRED)

Run the `use-tinyfish` pre-flight (CLI installed + authenticated). Stop with install/login instructions if either fails.

---

## Workflow

### 1. Assemble the inputs

Three things are needed — gather what's missing:

- **URL list** — from the user's message, an uploaded file, or discovered via `tinyfish search query` per entity (e.g. one search per company name to find its pricing page)
- **Extraction goal** — one JSON spec applied to every URL
- **Output columns** — the fields of that JSON, plus `url` and `status`

Confirm the goal on ONE sample URL before fanning out — run it, show the user the extracted row, adjust the spec if needed. This avoids burning a whole batch on a bad goal.

### 2. Choose the cheap path first

If the pages are static content, skip agent runs entirely:

```bash
tinyfish fetch content get --format markdown <url1> <url2> <url3> ...
```

Fetch accepts many URLs in one parallel call — extract the fields from the returned markdown yourself. Reserve batch agent runs for pages that are dynamic, interactive, or where fetch comes back empty.

### 3. Batch agent runs

Build a CSV with `url,goal` columns (same goal each row, JSON quotes escaped), then:

```bash
tinyfish agent batch run --input runs.csv
tinyfish agent batch get <batch_id>        # poll until terminal
```

Poll at a sensible interval and report progress at milestones (e.g. "23/40 complete"), not on every poll. Collect each run's `resultJson`; note per-run status.

For small lists (≤5 URLs), parallel individual `tinyfish agent run` calls are fine — skip the batch machinery.

### 4. Handle failures

- Retry failed runs individually with `tinyfish agent run` (once).
- Rows that still fail stay in the output with `status: FAILED` and an empty data cell — never silently drop URLs. Report the failure count and list up front.

### 5. Build the deliverable

Normalize all results into one table: one row per URL, consistent columns, numbers as numbers, dates in ISO format, a `status` column (OK / FAILED / EMPTY).

If a spreadsheet-authoring skill is available in this environment, read it first and produce an `.xlsx` (frozen header row, sensible column widths, failures highlighted). Otherwise produce a clean `.csv`. Name the file after the task (e.g. `competitor-pricing-2026-07-17.xlsx`).

### 6. Deliver and summarize

Send the file with a short summary: rows extracted, failures, and one or two notable observations from the data (highest/lowest, obvious outliers). Offer next steps where natural — turn it into a dashboard (`web-dashboard`) or watch a subset for changes (`web-watch`).

$ARGUMENTS

---
name: web-dashboard
description: Extract live data from websites with TinyFish and turn it into a polished, self-contained HTML dashboard — comparison tables, charts, stat tiles — that can be refreshed on demand. Use when the user wants a dashboard, tracker, comparison view, or visual report built from web data (e.g. compare prices across stores, track competitors, summarize listings).
---

# Web Dashboard

Extract structured data from the web, then render it as a single-file HTML dashboard the user can keep, open offline, and ask to refresh.

## Pre-flight Check (REQUIRED)

Run the `use-tinyfish` pre-flight (CLI installed + authenticated) before any extraction. Stop with install/login instructions if either fails.

---

## Workflow

### 1. Scope the dashboard

Establish with the user (ask only what's missing):

- **Sources** — which sites/URLs, or a topic to find sources for via `tinyfish search query`
- **Data** — which fields per source (name, price, rating, availability, date, …)
- **View** — comparison table, ranked list, charts, stat tiles, or a mix

### 2. Extract the data

Follow the `use-tinyfish` escalation ladder:

- Static pages → `tinyfish fetch content get` (batch multiple URLs in one call), extract fields from the markdown
- Dynamic/interactive pages → one `tinyfish agent run` per site, in parallel, each goal specifying the exact JSON shape:

```bash
tinyfish agent run --url "https://store-a.com/laptops" \
  "Extract all laptops as JSON: [{\"name\": str, \"price\": str, \"rating\": str, \"in_stock\": bool}]"
```

Normalize everything into one dataset: consistent field names, prices as numbers with a currency field, one `source` field per row. Record per-source fetch timestamps. If a source fails, include it in the dashboard as "unavailable" rather than silently dropping it.

### 3. Build the dashboard

A single self-contained HTML file — inline ALL CSS and JS, embed the dataset as a JSON constant, no external network calls (offline-safe, aside from optional CDN chart libraries when charts are needed).

If a data-visualization or design skill is available in this environment, read it before writing chart or layout code and follow its palette and mark rules.

Include:

- **Header** — dashboard title, "data as of <timestamp>" per source or overall
- **Stat tiles** — the headline numbers (cheapest, average, count, biggest change)
- **Main view** — the table/chart the user asked for; tables sortable via a small inline script
- **Sources footer** — each source URL and its fetch time, plus any that failed

Keep it clean and legible: readable defaults, consistent number formatting, no dead controls.

### 4. Deliver

Send the HTML file to the user with a one-line summary. If the environment supports persisting artifacts and this is something the user will reopen or share (a tracker or ongoing comparison rather than a one-off look), also persist it.

### 5. Refreshing

On "refresh the dashboard": re-run step 2 with the same sources and goals, rebuild with the new data, and note what moved since the previous version (e.g. "Store B dropped $40"). Save extraction config (sources, goals, fields) in a comment block at the top of the HTML so any future session can refresh it from the file alone.

For standing refreshes on a schedule, hand off to the `web-watch` skill for change tracking, or schedule a task whose prompt says to refresh this dashboard per this skill.

$ARGUMENTS

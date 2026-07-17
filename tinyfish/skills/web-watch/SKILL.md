---
name: web-watch
description: Watch any webpage for changes over time — price drops, stock status, competitor pages, job postings, changelogs, news — using TinyFish extraction with a saved baseline and change reports. Use when the user wants to monitor a page, track a price, get notified when something on a site changes, check a site on a schedule, or re-check an existing watch.
---

# Web Watch

Turn TinyFish's one-shot extraction into recurring monitoring: extract the fields that matter, save a baseline, and on every check report exactly what changed.

## Pre-flight Check (REQUIRED)

Run the same checks as `use-tinyfish`:

```bash
which tinyfish && tinyfish auth status
```

If the CLI is missing or unauthenticated, stop and give the user the install/login instructions from the `use-tinyfish` skill. Do NOT proceed until both pass.

---

## Watch State

Each watch lives in its own directory:

```
~/.tinyfish/watch/<slug>/
├── watch.json      # config: name, url, goal, fields, cadence
└── baseline.json   # last extracted values + ISO timestamp
```

`<slug>` is a kebab-case name derived from the watch name (e.g. `acme-pricing-page`).

**watch.json:**

```json
{
  "name": "Acme pricing page",
  "url": "https://acme.com/pricing",
  "goal": "Extract all plans as JSON: [{\"plan\": str, \"price\": str, \"features\": [str]}]",
  "compare_fields": ["plan", "price"],
  "cadence": "daily"
}
```

## Creating a Watch

1. **Clarify the target** — which URL, which specific things to track (prices? stock? headlines? whole text?), and how often to check. Ask only for what the user hasn't said.
2. **Write the extraction goal** — a precise JSON spec covering only the tracked fields. Fewer fields = fewer false alarms.
3. **Pick the extraction tool** — try `tinyfish fetch content get` first for static pages (extract fields from the markdown yourself); use `tinyfish agent run --url <url> "<goal>"` for dynamic or interactive pages. Record which tool worked in `watch.json` as `"tool": "fetch" | "agent"`.
4. **Take the baseline** — run the extraction, save the result to `baseline.json` with a timestamp, and show the user the captured values so they can confirm the watch is tracking the right things.
5. **Schedule it** (optional but offer it) — see Scheduling below.

## Checking a Watch

1. Read `watch.json` and `baseline.json` for the slug (list `~/.tinyfish/watch/` if the user didn't name one).
2. Re-run the same extraction.
3. Compare field-by-field against the baseline. Normalize before comparing: trim whitespace, ignore ordering of arrays unless order is what's being watched.
4. Report one of:
   - **No change** — one line: "No changes since <baseline timestamp>."
   - **Changes** — a compact before → after table of only the changed fields, plus anything added or removed.
   - **No baseline found** — take a fresh baseline, tell the user a new baseline was established (this happens when running in a fresh environment), and report current values.
5. Overwrite `baseline.json` with the new values and timestamp after reporting.
6. If extraction fails (site down, layout changed so fields come back empty), report the failure explicitly — never overwrite a good baseline with an empty result.

## Scheduling

If scheduled-task tools are available in this environment (e.g. `create_trigger` / `send_later` from a remote-session MCP), offer to schedule the check at the user's cadence. The scheduled prompt must be fully standalone, for example:

> Check my web watch named "acme-pricing-page": follow the tinyfish web-watch skill's "Checking a Watch" steps for the state in ~/.tinyfish/watch/acme-pricing-page/. If the baseline file is missing, re-baseline and say so. Report any changes clearly.

If no scheduling tools are available, tell the user they can re-run the check anytime by asking (e.g. "check my acme pricing watch"), or schedule it themselves with OS cron.

## Managing Watches

- **List**: enumerate `~/.tinyfish/watch/*/watch.json` and show name, URL, cadence, last-checked timestamp.
- **Delete**: remove the watch directory after confirming with the user.
- **Edit**: update `watch.json`, then take a fresh baseline so comparisons stay valid.

$ARGUMENTS

# Changelog

## 1.2.0 (2026-07-17)

### Added

- Reference: `browser-tasks/references/unblocking.md` — the "never get stuck" playbook. Auto-dismiss consent/cookie/age/region walls (incl. Google "Before you continue"), detect CAPTCHAs and bot checks (reCAPTCHA, hCaptcha, Cloudflare Turnstile, Amazon Robot Check, press-and-hold), and a bounded escalation ladder that hands off to a human instead of looping. Every run ends in a defined `DONE` / `BLOCKED` / `FAILED` state.

### Changed

- `browser-tasks` and `use-tinyfish` gained a "Getting unstuck" section wiring consent/CAPTCHA handling and the human-handoff pattern into every live-web run
- Manifest description and keywords note consent and CAPTCHA handling

## 1.1.0 (2026-07-17)

### Added

Five workflow skills built on top of the core toolkit (customization; core skills unchanged):

- Skill: `/tinyfish:web-watch` — watch any webpage for changes with saved baselines, field-level diff reports, and optional scheduled checks
- Skill: `/tinyfish:local-app-qa` — smoke-test a locally running app: tunnel it via tinyfi.sh, run browser-agent test flows against it, report pass/fail with evidence, tear down
- Skill: `/tinyfish:web-dashboard` — extract live web data and build a self-contained, refreshable HTML dashboard
- Skill: `/tinyfish:bulk-extract` — fan one extraction goal across a URL list via batch runs and deliver a spreadsheet
- Skill: `/tinyfish:browser-tasks` — do anything a human can do in a browser: forms, flows, carts, bookings — with confirmation gates before irreversible actions and independent outcome verification

### Changed

- Manifest description and keywords extended to cover the new workflow skills

## 1.0.0 (2026-04-15)

### Added
- Initial release of the TinyFish CLI plugin for Claude Code
- Skill: `/tinyfish:use-tinyfish` — complete CLI toolkit with 4-tool escalation ladder
  - `tinyfish search query` — web search with ranked results
  - `tinyfish fetch content get` — clean markdown extraction from URLs
  - `tinyfish agent run` — browser automation via natural language goals
  - `tinyfish browser session create` — headless browser with CDP control
- Skill: `/tinyfish:tunneling` — expose local ports via tinyfi.sh SSH tunnels
- Pre-flight checks for CLI installation and authentication
- Marketplace manifest for plugin discovery via `tinyfish-io/tinyfish-cookbook`

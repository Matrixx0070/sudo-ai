# Changelog

All notable changes to this project are documented here. Versioning follows the
`version` field in `package.json`; entries are newest-first.

## [4.1.7] — 2026-07-10

### Fixed
- Skill frontmatter parses YAML-first (js-yaml) — the hand-rolled parser's global
  quote-strip corrupted quoted content ("Don't" → "Dont", live victim: email-polish's
  description every boot); nested-key no-leak preserved, legacy fallback fail-open. (#667)
- Session persistence is write-through: `session.messages.push` persists immediately,
  closing the lost-message class behind four bug campaigns (#437, #445-447, #450/#451,
  #659). Kill-switch `SUDO_WRITE_THROUGH_PERSIST=0`. (#668, #670)
- Declared-primitive tool arguments coerce at the registry boundary — string `"500"` on
  a `type:'number'` param passed validation and poisoned the finance ledger (every later
  balance crashed); now strict finite-parse coercion for numbers alongside the #663
  boolean rule, recursing through declared nested schemas (array `items` / object
  `properties`, depth-capped) — `operations:[{width:"300"}]` no longer breaks image
  editing, github batch edits, or spreadsheet column widths. (#671, #674)

### Added
- `skill.eval` runs its independent (prompt × run) units concurrently under a bounded
  worker pool — a 12-call eval dropped 1211ms → 218ms mocked and 236s → 49s live;
  `SUDO_SKILL_EVAL_CONCURRENCY` (default 3, `1` = exact legacy sequencing), fan-out
  stops on first unit failure. (#672)
- Semantic recall assist for skill activation: when no trigger phrase matches, the
  message is embedded with the local MiniLM and matched against per-skill anchors —
  50% → 83% accuracy on a labeled intent set, first live semantic activation at
  similarity 0.51 on a keyword-free request. Recall-only (never vetoes a phrase match),
  400ms turn budget, failure cooldown; `SUDO_SKILL_SEMANTIC_ASSIST=0` disables;
  `skill.trigger-eval semantic=true` reports the combined matrix. (#673)

## [4.1.6] — 2026-07-09

### Fixed
- Agent loop: corrected final answers now persist. CompletionVerify retry adoptions and
  the universal-negative guard's corrective revisions are appended after the end-of-run
  session save; the delivered (revised) answer is now re-saved, so restarts and hydrates
  no longer resurrect the pre-revision text. (#659)

### Added
- `email-polish` workshop-authored skill tracked under `skills/`; npm pack tarballs
  gitignored. (#660)

## [4.1.2 – 4.1.5] — 2026-07-08 — combined fix train

### Fixed
- `sudo-ai start` boots from a clean npm install (#652); quickstart enables web chat so
  `/api/message` responds and persists (#653); shipped SPA served from the package
  install dir instead of cwd (#654); `resolvePackageRoot` no longer throws under mocked
  fs (#655); `doctor` gained provider-awareness, clean exit, sqlite-vec interop, and
  quieter git noise (#656); deprecated `temperature` param stripped for Claude 5 family
  models (#649).

### Added
- macOS support: Seatbelt exec sandbox, BSD ps/os metrics, restart guidance, install
  docs (#651).
- Universal-negative guard for research turns: a final answer asserting an unverifiable
  universal negative ("no other X exists", "no name collisions") from finite web
  searches gets one bounded corrective rescope; kill-switch
  `SUDO_UNIVERSAL_NEGATIVE_GUARD=0` (#657, #658).
- Skill Workshop self-authoring (`skill.apply` / `skill.rollback`) reachable via tool
  routing (#641–#648); slim heartbeat context + memory-injection caps (#650).

## [4.1.0] — 2026-07-05 — Initial public release

First public release of **SUDO-AI**, a self-hosted, owner-operated autonomous AI agent
platform. Install with one command and run your own always-on agent.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/Matrixx0070/sudo-ai/main/install.sh | bash
# or
npm i -g @matrixx0070/sudo-ai
```

Then `sudo-ai quickstart` (add API keys), `sudo-ai chat`, or `curl http://127.0.0.1:18900/health`.
The installer is non-interactive when piped, prefers a prebuilt bin, and builds from
source as a fallback.

### Highlights

- **One-command install** → global `sudo-ai` CLI (`chat`, `quickstart`, `doctor`, `start`,
  `status`, …) plus an optional pm2/systemd service, validated end-to-end on a clean
  Linux box.
- **Multi-model brain** with configurable provider failover (Anthropic / OpenAI / xAI /
  Google / local Ollama), streaming, and prompt caching.
- **Built-in tool suite**: code editing & search, a Playwright browser agent (stable
  element refs, SSRF/DNS-pinned fetch), sandboxed system exec, document & media
  generation (PDF/slides/charts/diagrams/QR/…), a GitHub connector, messaging channels
  (Telegram/Slack/…), and an MCP client.
- **Verified continual-learning flywheel**: mines real tool-execution traces, verifies
  candidate harness improvements four ways (deterministic replay, guidance A/B,
  workflow-order, retry-policy), and applies vetted lessons behind a gated,
  auto-reverting canary. Includes a periodic harness-bug scan. All learning is off by
  default and never auto-mutates the running agent without opt-in.
- **Security & supply chain**: sandboxed execution, SSRF and DNS-pinning guards, an
  encrypted credential vault, output redaction, timing-safe auth, plus release
  provenance (SLSA), an SBOM, pinned GitHub Actions, and CI contract guards.
- **Interfaces**: a web chat SPA and a terminal chat TUI, with file upload and inline
  media delivery.

See [`README.md`](./README.md) and [`BOOTSTRAP.md`](./BOOTSTRAP.md) for full
documentation and configuration.

### Notes

- Linux is the primary target for this release; macOS/Windows are best-effort.
- Bring your own model API keys (or run a local model) — configure via `sudo-ai quickstart`
  or `config/.env`.

[4.1.0]: https://github.com/Matrixx0070/sudo-ai/releases/tag/v4.1.0

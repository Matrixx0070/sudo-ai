# Changelog

All notable changes to this project are documented here. Versioning follows the
`version` field in `package.json`; entries are newest-first.

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

# Text-Processing Toolchain (Spec 10)

SUDO has composable, low-memory access to the classic Unix text toolchain,
modern high-performance replacements, and structured-data processors — with
binary auto-detection, pure-Python fallbacks, and intelligent routing.

This doc is for **operators** (provisioning + extending). Agent-facing guidance
lives in the tool descriptions and the Tool Capability Manifest, not here.

## What the agent gets

Four first-class tools (category `textproc`, kill-switch `SUDO_TEXTPROC=0`):

| Tool | Purpose |
|---|---|
| `textproc.capabilities` | List installed tools + best provider per role (native/alias/python/none). |
| `textproc.extract` | Exact line/byte/field slices of multi-GB files without loading them. |
| `textproc.replace` | Safe find-replace: dry-run diff preview (default), timestamped backups, binary refusal. |
| `textproc.analyze` | Streaming CSV/TSV/JSONL stats / groupby / freq (Miller, or python fallback). |

Everything else composes through `system.exec`, which now auto-approves ~45
read-only text tools (rg, jq, mlr, gron, yq, datamash, htmlq, cut, sort, …) as
single commands. Pipelines still go through the approval gate (metachar rule);
`sed`/`awk`/`perl` auto-approve only in read form — an in-place write flag
(`-i`) defers to approval.

## Provisioning

The agent never installs binaries. An operator runs, once:

```bash
sudo ./scripts/provision-textproc.sh          # apt + pip venv + pinned GitHub bins + symlinks
./scripts/provision-textproc.sh --check        # coverage table, exit 0/1 (no root needed)
sudo ./scripts/provision-textproc.sh --offline # skip GitHub downloads
```

Sources: apt (moreutils, datamash, miller, colordiff, parallel, entr, gron, sd,
dasel, xq, yq, ugrep, html-xml-utils, jo), a dedicated pip venv at
`data/textproc-venv/` (pyyaml, csvkit, pyp, visidata), sha256-pinned GitHub
release binaries → `/usr/local/bin` (choose, fx, jless, htmlq, difft, qsv, teip,
rga), and `bat`/`fd` symlinks over the Debian `batcat`/`fdfind` names. Every
GitHub asset is pinned by tag + SHA256 in the script; a mismatch refuses to
install. Missing distro packages log `SKIPPED` loudly — the capability registry
is the source of truth regardless.

After provisioning, refresh the manifest: `textproc.capabilities {refresh:true}`
or restart the daemon (it warms the manifest at boot and logs a one-line
coverage summary).

## Untrusted (Docker) tier

Untrusted turns (non-owner: hook/email/community) exec inside
`docker/Dockerfile.sandbox`, which carries a curated subset — ripgrep, jq,
gawk, miller, datamash, and python3-yaml (for the yq fallback) — so real
log/CSV/JSON/YAML work runs with `network:none`. Host-only tools (delta, difft,
GitHub-release binaries) are honestly reported unavailable in that tier's
manifest. Rebuild after Dockerfile changes:

```bash
docker build -f docker/Dockerfile.sandbox -t sudo-ai-sandbox:latest .
```

## Extending (plugins)

Add tools without code changes via `config/textproc-plugins.json5` — an array of
catalog entries (`{ name, aliases?, category, roles, streaming, fallback?,
safety?, hint? }`). Built-in entries win name conflicts; malformed entries are
ignored with a warning. Roles the agent can resolve are defined in
`ROLES` in `src/core/tools/builtin/textproc/capabilities.ts`.

## Architecture

- `capabilities.ts` — catalog (~60 tools), single-process PATH probe cached to
  `data/textproc-manifest.json` (PATH-hash + 24h TTL), role resolution
  `native → alias → alt → python → none`, plugin merge, summary line.
- `fallbacks/*.py` — stdlib-first pure-Python fallbacks (yq, gron, csv,
  datamash, xml, html, sponge, ts); PyYAML is the only non-stdlib import.
- `proc.ts` — byte-capped spawn runner (argv arrays only; SIGKILL at the cap
  bounds RSS). The only shell use is fixed bash templates with positional args.
- `extract.ts` / `replace.ts` / `analyze.ts` — the three workhorse tools.

## Acceptance (verified live 2026-07-14)

- **A1** line 20,000,000 of a 1.2 GB log in 751 ms at 85 MB RSS; near-EOF byte range in 5 ms.
- **A2** 1M-row CSV groupby via Miller (streaming).
- **A3** with mlr hidden from PATH, the same call succeeds via `csv_fallback.py`, reporting `via:'python'`.
- **A5** all 6 natural-language probes route the textproc category (6/6).
- **A6** mlr + python-yaml + rg/jq run inside the `network:none` untrusted container.
- **A7** `SUDO_TEXTPROC=0` → 0 tools registered; default → 4.
- **A8** full textproc + router + manifest suites green; lint + build green.

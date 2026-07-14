# Spec 10 — Text-Processing Toolchain Foundation (textproc)

**Status:** PLANNED (authored 2026-07-14 by Fable 5 from a live audit; see auto-memory
`project-textproc-toolchain-audit` and wiki note
`20260714003251338247-sudo-ai-text-processing-toolchain-audit`).
**Executor:** Opus-class agent, working PR-by-PR on `/root/sudo-ai-v4`, deployed as pm2 `sudo-ai-v5`.

## 0. Mission

Give SUDO efficient, composable access to classic Unix text processing + modern
high-performance replacements + structured-data processors, so it can:
extract precise line/field ranges from multi-GB files without loading them,
search/filter/transform logs, code, JSON/YAML/CSV/HTML/XML, build streaming
pipelines, do terminal-native data analysis, and run safe find-replace /
diff / versioning workflows — with **auto-detection of available binaries,
pure-Python fallbacks, plugin extensibility, and intelligent tool selection**.

## 1. Current state (audited 2026-07-14, do NOT re-audit — spot-check only)

**Already solid — build ON this, do not rebuild:**
- `system.exec` (`src/core/tools/builtin/system/shell-exec.ts`): `/bin/bash -c`,
  so pipes/redirects/process-substitution already compose. Output clamped to
  8,000 chars head/tail (`clampHeadTail`), default timeout 60s, approval gate
  `EXEC_APPROVAL_MODE` (default allowlist).
- bwrap sandbox (`src/core/sandbox/sandbox-runner.ts:236-242`) ro-binds
  `/usr`,`/bin`,`/lib` → every host binary is reachable on owner turns.
- Trust-tier routing (Spec 8): untrusted (non-owner) turns exec inside
  `docker/Dockerfile.sandbox` (node:20-slim + python3 only).
- Host binaries present: full GNU coreutils set, sed, gawk+mawk, grep family,
  sort/uniq/cut/paste/join/comm/csplit/tr/nl/tac/rev/shuf/fold/fmt,
  diff/patch/sdiff, wc/file/strings/base64/iconv/expand/unexpand,
  perl, python3, **rg, batcat, fdfind, fzf, jq**, curl, wget.

**Verified MISSING on host (`command -v`, 2026-07-14):**
- moreutils (all): `sponge ifne ts combine pee vipe`
- modern: `sd choose ugrep delta difft colordiff` (bat/fd exist only as
  Debian `batcat`/`fdfind` — no aliases)
- structured: `yq gron dasel mlr xsv qsv csvkit jo fx jless xq pup htmlq`
- workflow: `parallel entr teip pyp datamash`
- bonus: `rga visidata`

**Structural gaps:**
1. No binary auto-detection / capability registry.
2. No pure-Python fallback layer.
3. Untrusted Docker sandbox has almost none of the toolchain.
4. No router reachability for text-processing intent (no keywords → the model
   never learns what's installed).
5. Exec allowlist doesn't cover read-only text tools → every pipeline waits on
   approval (or runs gate-off).
6. No safe find-replace / diff-preview / rollback workflow tool.
7. No plugin path for adding future tools.

## 2. Non-goals

- No TUI/interactive tools in agent paths (`vipe`, interactive `fzf`,
  `visidata` TUI). Non-interactive modes only.
- No re-implementation of anything bash already composes (do NOT build a
  "pipeline DSL" — bash IS the pipeline DSL; we add detection, fallbacks,
  safety, and reachability around it).
- No changes to the approval-gate architecture itself.
- No enforced egress changes (tools are local-only).

## 3. Design decisions (pre-made — do not re-litigate)

- **D1. One new tool module** `src/core/tools/builtin/textproc/` with a SMALL
  agent-facing tool surface (4 tools, §5.3). Everything else flows through
  `system.exec` as today. Rationale: 80+ tools already strain the router; the
  win is capability *knowledge* + *safety*, not 40 wrapper tools.
- **D2. Fallback resolution order:** native binary → alternative binary
  (e.g. `bat`→`batcat`, `fd`→`fdfind`, `xsv`→`qsv`→`mlr`) → pure-Python
  module → honest "unavailable" (never silently degrade correctness).
- **D3. Python fallbacks are stdlib-first** (json/csv/difflib/re/statistics/
  xml.etree/html.parser); third-party only PyYAML (for yq fallback) installed
  into a dedicated venv `data/textproc-venv/` (NEVER system pip — PEP 668).
- **D4. Everything env-gated, default ON, kill-switch** `SUDO_TEXTPROC=0`
  (repo convention: default-on with kill-switch for pure-additive capability;
  match Spec 8's `SUDO_SANDBOX_TIER_ROUTING` pattern).
- **D5. Provisioning is a script + opt-in boot check, not an installer tool.**
  The agent must never `apt install` autonomously; the operator runs
  `scripts/provision-textproc.sh` once. Boot logs a one-line coverage summary.
- **D6. Sandbox image parity is a curated SUBSET** (rg, jq, coreutils-full,
  mlr, sd, gawk, datamash — small, static, no network needs), keeping the
  image lean. Untrusted turns don't get GNU parallel or entr.

## 4. Provisioning inventory (Phase 0 reference)

| Source | Packages |
|---|---|
| apt | `moreutils datamash colordiff miller gawk parallel entr jo html-xml-utils` |
| apt (verify names first, Ubuntu 24.04) | `ripgrep-all` (else skip rga), `ugrep` |
| pip (venv `data/textproc-venv/`) | `pyyaml yq csvkit gron-py? (no — see below) pyp visidata` |
| GitHub release binaries → `/usr/local/bin` (pin version + sha256 in script) | `sd choose gron dasel fx jless xq htmlq delta difft qsv teip` |
| symlinks | `/usr/local/bin/bat → batcat`, `/usr/local/bin/fd → fdfind` |

Rules for the script (`scripts/provision-textproc.sh`):
- Idempotent; `--check` mode prints coverage table and exits 0/1; `--offline`
  skips GitHub downloads. Every GitHub download sha256-pinned (supply-chain
  memory `project-supplychain-hardening-522` applies). Never curl|bash.
- After install, run the detection probe (§5.1) and print the manifest diff.
- If a package name doesn't exist on the distro, log SKIPPED loudly — no
  silent holes; the capability registry is the source of truth anyway.

## 5. Architecture

### 5.1 Capability registry — `src/core/tools/builtin/textproc/capabilities.ts`

- `detectCapabilities(): Promise<TextprocManifest>` — probes a static catalog
  (~60 entries) with `command -v` equivalent (execFile `bash -lc 'command -v'`
  batched, or fs.access over PATH — pick ONE, test both cold and cached).
- Catalog entry shape:
  `{ name, aliases: string[], category: 'classic'|'modern'|'structured'|'workflow'|'diff'|'bonus', roles: string[] /* e.g. 'json-query','csv','find-replace' */, streaming: boolean, fallback?: FallbackRef, safety?: { bannedFlags?: string[], requiredFlags?: string[], note?: string } }`
- Resolution: `resolve(role: string): Resolution` returns the best available
  provider for a role per D2 order, with `via: 'native'|'alias'|'alt'|'python'|'none'`.
- Cache to `data/textproc-manifest.json` with PATH-hash + mtime invalidation;
  `refresh()` forced by the provision script and by `textproc.capabilities
  {refresh:true}`.
- **Plugin extensibility:** merge additional catalog entries from
  `config/textproc-plugins.json5` (same shape) so future tools need zero code.
  Validate shape, ignore-with-warn on bad entries.

### 5.2 Python fallback layer — `src/core/tools/builtin/textproc/fallbacks/`

One `.py` file per role, executed via the existing PTC-python/bwrap path
(reuse `python-exec` machinery — see `project-ptc-python` memory; do NOT
spawn raw unsandboxed python). All read stdin → write stdout, streaming
line-by-line where the role permits:
- `yq_fallback.py` (PyYAML: yaml→json for jq, json→yaml back)
- `gron_fallback.py` (flatten/ungron JSON — pure stdlib)
- `csv_fallback.py` (cut/filter/stats/to-json/from-json — stdlib csv; covers
  the mlr/xsv role minimally)
- `datamash_fallback.py` (sum/mean/median/min/max/count/groupby — statistics)
- `xml_fallback.py` (xpath-lite via xml.etree)
- `html_fallback.py` (CSS-selector-lite via html.parser; document its limits
  honestly in the tool output when used)
- `sponge_fallback.py` (read-all-then-write, the one moreutils bit worth a
  fallback), `ts_fallback.py` (timestamp lines)
Each ≤150 lines, no third-party imports except PyYAML, each with a golden
stdin/stdout test fixture.

### 5.3 Agent-facing tools (module `textproc`, registered via `loadBuiltinTools`)

1. **`textproc.capabilities`** — returns the manifest grouped by role, with
   `via` markers and one-line usage hints (e.g. "CSV stats: mlr (native)" /
   "YAML: python fallback — limited"). Params: `{ role?, refresh? }`.
   This is the "intelligent tool selection" primitive: cheap, cacheable,
   and the router injects its SUMMARY (§5.4).
2. **`textproc.extract`** — precise, memory-bounded extraction from huge
   files: `{ file, lines?: 'START-END', bytes?: 'START-END', fields?: {sep, cols}, head?, tail?, maxOutput? }`.
   Implementation composes `sed -n 'A,Bp;Bq'` / `tail -c`+`head -c` / `cut`
   via execFile arg-arrays (NO shell string interpolation of user input).
   Must never read the whole file (use `;q` early-exit sed, verify with a
   multi-GB acceptance test §8-A1).
3. **`textproc.replace`** — safe find-replace: `{ file|glob, find, replace, regex?: bool, dryRun (DEFAULT true), backup (DEFAULT true) }`.
   dryRun returns a unified diff preview (delta/difft for display if present,
   plain `diff -u` data always); apply writes `<file>.bak.<ts>` (or uses git
   if the file is tracked — say which in the result), uses `sd` when
   available else perl `-pe` else python fallback. Refuses binary files
   (`file` probe). This is the "safe find-and-replace + versioning" story.
4. **`textproc.analyze`** — lightweight aggregation over delimited/JSON
   input: `{ file|stdin, format: csv|tsv|jsonl, op: stats|groupby|freq|histogram, keys?, valueField? }`
   → routes to mlr/datamash/qsv per resolution, python fallback otherwise.
   Streaming; row cap with honest truncation note.

Complex/creative pipelines stay on `system.exec` — the tools above cover the
high-frequency, high-risk shapes; the capability manifest teaches the model
what to compose manually for the rest.

### 5.4 Router reachability (learn from #743 — this is where features die)

- New category `'textproc'` in `tool-router.ts` `RoutingCategory` union +
  rules map. Keywords (WHOLE-WORD matching — plurals/variants must be listed
  explicitly, the #743 lesson): `csv, tsv, json, jsonl, yaml, yml, xml, html,
  log, logs, grep, search, extract, parse, filter, transform, pipeline,
  regex, replace, diff, dedupe, deduplicate, aggregate, sort, count, column,
  columns, field, fields, lines, tail, head, jq, awk, sed`, plus patterns
  `/find.{0,20}(replace|in files)/i`, `/\.(csv|tsv|json|yaml|yml|xml|html|log)\b/i`.
- Cap MUST admit all 4 textproc tools + system.exec (cap ≥ 5; caps must track
  category size — #743). Watch keyword overlap with 'coder'/'system': a hit
  in both is fine, dedupe is by tool name.
- Additionally append a ONE-LINE capability summary to the tool manifest
  block the model sees (e.g. `textproc: rg,jq,mlr,sd native; yaml via
  python`) so selection is informed without a tool call. Keep ≤200 chars;
  regenerate from the cached manifest, never probe at prompt-build time.

### 5.5 Allowlist + safety

- Extend `security/approval/allowlist.ts` SAFE set with read-only text tools
  (bare names, they compose in pipes): `rg grep egrep fgrep sed awk gawk cut
  tr sort uniq head tail nl tac wc comm join paste fold fmt column jq mlr
  gron dasel yq xsv qsv datamash file strings diff sdiff batcat bat fdfind
  fd choose sd teip xq pup htmlq jless fx delta difft colordiff shuf rev
  csplit expand unexpand base64 iconv jo`. NOTE: `sed`/`awk` can write via
  `-i`/redirection — if the allowlist is name-based only, gate `sed -i` and
  `gawk -i inplace` behind the normal approval path (flag-scan like the
  existing curl handling at allowlist.ts:96-108); pipes/redirects already go
  through the full-command path, so only flag-writes need the scan.
- Banned in agent paths (enforce in catalog `safety` + a pre-exec scan):
  `vipe` (interactive), `parallel` without `-j` cap (inject `-j4` guidance;
  also `--will-cite` note), `fzf` without `--filter`, `entr` only with
  timeout wrapper. `rm`-adjacent moreutils none exist — no action.
- `python -c` restricted execution: DON'T build a bespoke python sandbox —
  route through the existing PTC bwrap path; document that `python3 -c` via
  system.exec inherits the exec sandbox policy (that IS the restriction).

### 5.6 Sandbox image parity (untrusted tier)

- Extend `docker/Dockerfile.sandbox`: add `ripgrep jq gawk miller datamash
  coreutils sed grep python3-yaml` via apt (all small; keep --no-install-
  recommends; measure image delta, target < +60 MB). Copy the python
  fallbacks into the image (`COPY src/core/tools/builtin/textproc/fallbacks
  /opt/textproc-fallbacks` — check .dockerignore) so the fallback layer works
  with `network:none`.
- Capability detection must run PER BACKEND: the manifest is keyed by backend
  (`host` | `docker`) — the docker manifest is generated by running the probe
  inside the image at build time and baking `manifest.docker.json`, refreshed
  by the image build script. NEVER report host capabilities for an untrusted
  turn (that's a correctness/honesty bug class).

## 6. Phased delivery (one PR per phase, repo conventions apply to each)

Every PR: unit tests + `pnpm build` if import graph changes (bundler breaks
aren't caught by tests — semantic-assist lesson) + verifier agent pass before
commit + `git status -sb` before commit (daemon auto-fix branch theft —
Spec 9 lesson) + live-drive proof on prod after merge.

- **PR-1 (Phase 0): provisioning.** `scripts/provision-textproc.sh` (+
  `--check`), symlinks, venv, sandbox Dockerfile extension + baked docker
  manifest, docs. Operator runs it; commit records the post-run coverage
  table in the PR body. No product code paths change yet.
- **PR-2 (Phase 1): capability registry** + `textproc.capabilities` tool +
  plugin merge from `config/textproc-plugins.json5` + boot summary log.
  Kill-switch `SUDO_TEXTPROC=0` lands here and gates the whole module load.
- **PR-3 (Phase 2): python fallback layer** + resolution order wired into the
  registry, golden-fixture tests per fallback, honest `via:` reporting.
- **PR-4 (Phase 3): the three workhorse tools** (`extract`, `replace`,
  `analyze`) with execFile arg-array construction, dryRun-default replace,
  binary-file refusal, truncation honesty.
- **PR-5 (Phase 4+5): router category + manifest summary line + allowlist
  extension + safety flag-scans.** Reachability probe REQUIRED before merge:
  ≥6 natural phrasings ("pull rows where status=500 from this csv", "replace
  foo with bar across src/", "how many unique IPs in this log", "give me
  lines 100000-100050 of x", "convert this yaml to json", "diff these two
  files nicely") must route the textproc category — the #678/#743 probe
  pattern; wait 80s+ post-restart before probing.
- **PR-6 (Phase 6): acceptance + docs.** Run the full §8 suite live, write
  `docs/textproc.md` (operator: how to provision/extend; agent-facing
  guidance lands in the tool descriptions, not docs), update CHANGELOG.

Deferred (record, don't build): rga/visidata integration beyond detection;
enforced parallel/entr policies beyond guidance; `xsv` (dead upstream — qsv
is the maintained fork, prefer it); interactive takeover of any TUI tool.

## 7. Repo-specific gotchas the executor MUST honor

1. Router keywords are WHOLE-WORD; caps must track category size (#743).
2. Registered ≠ reachable — always live-probe routing (#641/#678/#680 class).
3. Any new runtime dep goes in `dependencies`, never devDeps (typescript
   lesson, `project-supplychain-hardening-522`; tar lesson Spec 9).
4. `skill-meta`-style tests may assert tool COUNTS — adding 4 tools will
   break any registry-count assertion; fix the expected count, don't skip.
5. Boot race: gateway accepts turns ~70s before full attach — probes wait 80s+.
6. Live prod = pm2 `sudo-ai-v5` running `tsx` from this working tree; deploy
   = merge → pull → `pm2 restart sudo-ai-v5` → check
   `data/logs/sudo-ai-v5-out-*.log` (NOT ~/.pm2/logs).
7. Env config lives in `config/.env` (repo-root `.env` is a dead-letter file).
8. Never OTP-relay/npm-publish locally; irrelevant here unless a release is cut.
9. This machine OOMs on huge non-streaming greps of giant files — the
   acceptance tests themselves must stream (use `head -c`, `sed q`, rg with
   `--max-count`), practice what we ship.
10. After code changes run `graphify update .`.

## 8. Acceptance criteria (each = a command + expected output, run LIVE)

- **A1 (multi-GB, low memory):** generate a 3 GB synthetic log
  (`yes ... | head -c 3G`, put in /tmp, delete after). `textproc.extract`
  lines 20,000,000-20,000,050 returns in <10 s with RSS of the child <100 MB
  (`/usr/bin/time -v` Maximum resident set size). Same file: `rg -c` a
  pattern via system.exec completes without OOM.
- **A2 (structured):** round-trip yaml→jq-filter→yaml on a real file via the
  yq resolution; CSV groupby-mean via `textproc.analyze` on a 1 M-row CSV
  (streaming); one HTML CSS-selector extraction; one XML xpath extraction;
  `gron | rg | gron -u` pipeline works.
- **A3 (fallback proof):** with a PATH shadow hiding mlr+yq (`env PATH=...`
  or temp rename in a test sandbox — NOT uninstalling), the same A2 calls
  succeed via python fallbacks and the results report `via:'python'`.
- **A4 (safe replace):** `textproc.replace` dryRun shows a correct diff on a
  20-file glob; apply creates backups; a deliberate bad regex refuses
  cleanly; rollback from `.bak` restores byte-identical files; binary file
  refused.
- **A5 (reachability):** the 6 routing probes of PR-5 all select textproc
  tools and the turn's chosen tool is the intended one (check
  `matchedCategories` + tool-choice in prod logs).
- **A6 (untrusted parity):** a signed webhook turn (Spec 8 harness) runs
  `mlr --icsv stats` AND a python-fallback yaml parse INSIDE the docker
  sandbox with `network:none`; host-only tools (e.g. `delta`) honestly
  reported unavailable in that tier's manifest.
- **A7 (kill-switch):** `SUDO_TEXTPROC=0` → module absent from registry,
  boot log line confirms, existing 8.x suites still green.
- **A8 (no regressions):** full `pnpm test` green; lint green; `pnpm build`
  green; count-asserting tests updated deliberately (diff shows the number
  change with a comment).

## 9. Definition of done

All A1-A8 executed with outputs recorded in the final PR body; provisioning
coverage table shows every §4 row either INSTALLED or SKIPPED-with-reason;
verifier agent returned SHIP (or HOLD findings fixed) on every PR; prod
daemon restarted and boot summary line observed; auto-memory
`project-textproc-toolchain-audit` updated from PLANNED→LIVE with gotchas
discovered during the build.

# macOS Readiness Assessment — SUDO-AI 4.1.0

Date: 2026-07-08. Assessed from the Linux dev box (branch `main`, `@matrixx0070/sudo-ai@4.1.0` on npm).
Method: dependency/lockfile metadata, source inspection, and inspection of the actual published npm tarball (`npm pack @matrixx0070/sudo-ai@4.1.0`). No Mac was available — anything that could only be proven by running on macOS is explicitly labeled UNVERIFIED.

---

## VERDICT

**Partially works (degraded features).**

The package installs and the daemon should boot on macOS (all native deps ship darwin-arm64/x64 prebuilds, paths are portable, the published tarball ships a bundled `dist`), **but the agent's core `system.exec` tool fails on every call out-of-the-box**: the exec sandbox is enabled by default and hardcodes `/usr/bin/bwrap`, a Linux-only binary, with no darwin detection and no availability probe. The only escape hatches are `SUDO_SANDBOX_DISABLE=1` (runs unsandboxed) or `SUDO_EXEC_BACKEND=docker` (requires Docker Desktop). A Mac user who just runs `npm i -g && sudo-ai start` gets a chatting agent whose shell tool is broken.

---

## BLOCKERS (ranked)

| # | Item | Axis | Evidence | Mac impact | Fix effort | Proposed fix |
|---|------|------|----------|------------|------------|--------------|
| 1 | **bwrap exec sandbox, default-ON, no darwin fallback** | Linux syscalls | `src/core/sandbox/sandbox-types.ts:59-61` (`DEFAULT_SANDBOX_POLICY = { enabled: true, ... }`); `src/cli.ts:767-771` injects it as the agent's default policy; `src/core/tools/builtin/system/shell-exec.ts:283-299` routes every enabled-policy exec to the bwrap runner; `src/core/sandbox/sandbox-runner.ts:34` (`BWRAP_BIN = '/usr/bin/bwrap'`) and `:343` (`execFileAsync(BWRAP_BIN, ...)`) — no `process.platform` check, no existence probe. `buildBwrapArgs` also binds Linux paths (`/lib64`, sandbox-runner.ts:15). | Every agent `system.exec` call errors (ENOENT on `/usr/bin/bwrap`). CONFIRMED from code; exact error surface UNVERIFIED without a Mac. | docs-only workaround (`SUDO_SANDBOX_DISABLE=1`, sandbox-runner.ts:301, or `SUDO_EXEC_BACKEND=docker`, exec-backend.ts); code-change for a real fix | Boot-time probe: if `process.platform !== 'linux'` or bwrap missing, log a loud warning and set the agent policy `enabled:false` (or ship a macOS `sandbox-exec`/seatbelt backend — `sandbox-profiles.ts` already carries a `useSeatbelt` flag at :148-150 but **no seatbelt runner exists**; `grep -rl "sandbox-exec" src` matches only sandbox-profiles.ts). |
| 2 | **Self-restart / self-update / service-control assume pm2 → systemctl** | Process mgmt | `src/core/tools/builtin/meta/restart-helper.ts:18-45` — `PM2_RESTART` else `systemctl restart sudo-ai`; `service-control.ts:198,220` same pattern. macOS has neither systemctl nor (typically) pm2. | `meta.service-control restart`, self-modify restart, self-update restart all fail. Daemon itself runs fine — `sudo-ai start [-d]` is a plain-node mode (`src/cli/index.ts:101-112`), pm2 is NOT a hard dependency for running. | docs-only | Document `SUDO_RESTART_CMD` (already honored, restart-helper.ts:35-37) for Mac users, e.g. a launchd `launchctl kickstart` or a `sudo-ai stop && sudo-ai start -d` wrapper; optionally ship a launchd plist template. |
| 3 | **`ps aux --no-headers` is GNU-only** | Linux syscalls | `src/core/tools/builtin/system/process.ts:89,106` and `monitor.ts:130` (`--sort=-%cpu` also GNU-only). macOS BSD `ps` rejects `--no-headers`. | `system.process` list/inspect and monitor top-processes fail on mac (command error). CONFIRMED flag mismatch; exact failure text UNVERIFIED. | code-change (small) | Platform-branch the ps invocation (`ps aux | tail -n +2` works on both) in process.ts/monitor.ts. |
| 4 | **`/proc` metric readers** | Linux syscalls | `src/core/tools/builtin/system/monitor.ts:37-166` reads `/proc/stat`, `/proc/meminfo`, `/proc/diskstats`, `/proc/net/dev`, `/proc/uptime`, `/proc/loadavg`; `readProcFile` swallows errors and returns `''` (monitor.ts:28-34); process.ts:60 reads `/proc/<pid>/{status,cmdline}`. | Silent degradation: `system.monitor` returns all-zero metrics on mac (no crash). | code-change (small) | Darwin branch using `os.loadavg()`/`vm_stat`/`sysctl`, or return an honest "unsupported on darwin" instead of zeros. |
| 5 | **computer-use GUI/desktop/browser backends are stubs on mac** | Linux syscalls | `src/core/tools/builtin/computer-use/cross-platform/mac.ts:5` ("osascript + fs, with several actions stubbed"), :88/:131/:142 stub errors; docs admit it (`docs/cross-platform-control-guide.md:7`, README.md:28). | `control.gui`/`control.desktop`/`control.browser` return honest stub errors. Playwright-based `browser.*` tools are a separate path and are mac-capable. | code-change (large, already flagged experimental) | Out of scope for "runs"; keep documented as experimental, optionally kill-switch via `SUDO_CROSS_CONTROL_DISABLE=1` (docs/api-reference.md:428). |
| 6 | **External binaries: ffmpeg, poppler** | Linux binaries | Whisper STT decodes via a local ffmpeg subprocess (`src/core/voice/whisper-local.ts:10-13` — loads gracefully when absent); pdf tools shell out to poppler (`src/core/tools/builtin/document/tools/pdf-extract-text.ts`, `pdf-edit.ts`; memory: #520 pdf-merge/extract via poppler); media/animation tools use ffmpeg (`src/core/tools/builtin/media/*`). | Voice STT, video, and PDF-extract tools fail per-call until `brew install ffmpeg poppler`. Degradation is per-tool, not boot-fatal. | docs-only | Add to BOOTSTRAP.md prerequisites (ffmpeg already has a `brew` hint at BOOTSTRAP.md:24; poppler has none). |
| 7 | **sqlite-vec extension lookup is cwd-relative** | Native modules | `src/core/memory/db.ts:227-246` — `_findVecExtension()` searches `process.cwd()/node_modules/sqlite-vec-<platform>-<arch>/vec0` (handles `.dylib`), falls back to BM25-only with a log (db.ts:220-223). `sudo-ai start` sets cwd to the install root (`src/cli/index.ts:83` INSTALL_ROOT; `src/cli/commands/start.ts:122` `cwd: projectRoot`), so global installs should find it — but running from-source with a different cwd, or an npm layout that doesn't nest deps under the package dir, silently drops vector search. | Degraded (BM25-only memory search), not fatal. UNVERIFIED which npm-global layouts hit it. | code-change (small) | Resolve via `require.resolve('sqlite-vec-...')`/`import.meta.resolve` instead of cwd. |

Non-blockers worth knowing: watchdog/cron liveness scripts (`scripts/cron-ensure-alive.sh`) are pm2/cron-flavored and are **not shipped in the npm tarball** (verified: tarball contains only `dist/`, `config/`, docs — 279 entries), so they simply don't exist on a Mac install.

---

## What works out-of-the-box on mac (green list)

All "works" claims below are from dependency metadata / published-package inspection, not a live Mac run.

- **Published package is runnable without a build step**: tarball ships bundled ESM `dist/` (269 dist files incl. `package/dist/server/cli.js`; verified by `tar tzf matrixx0070-sudo-ai-4.1.0.tgz`), `bin: {'sudo-ai': './dist/server/cli.js'}`, `engines: node >=20`, **no `os` field** (installs on darwin). `tsx` is devDependency-only; the published CLI needs plain Node. The `postinstall` script no-ops in the published package (it guards on `esbuild.config.cjs` + `scripts/build-synth-seal.sh`, neither shipped — verified in the tarball's package.json).
- **Native deps all have darwin prebuilds** (lockfile evidence, pnpm-lock.yaml):
  - `sqlite-vec-darwin-arm64@0.1.7` / `sqlite-vec-darwin-x64@0.1.7` (lines 4863-4870), loader handles `.dylib` (db.ts:233).
  - `@img/sharp-darwin-arm64@0.35.2` / `-x64` (lines 801-819).
  - `@esbuild/darwin-arm64@0.27.4` etc. (lines 505-515) — dev-only anyway.
  - `onnxruntime-node@1.21.0` declares `os: [win32, darwin, linux]` (lines 4242-4244) → local Whisper STT, Kokoro TTS, and local embeddings (all via `@huggingface/transformers`/`kokoro-js`, lazy optionalDependencies — whisper-local.ts:12, kokoro.ts:12, local-embeddings.ts:19) are CPU-only under Node (kokoro.ts:120) and should run on Apple Silicon. UNVERIFIED live.
  - `better-sqlite3@12.8.0` (line 2246) ships prebuilds for darwin via prebuild-install; falls back to source build needing Xcode CLT if the Node ABI has no prebuild. UNVERIFIED which Node minor a user has.
  - `playwright@1.58.2` supports macOS; Chromium downloads on first use or `npx playwright install chromium` (BOOTSTRAP.md:23).
  - No linux-only pinned runtime dep found in the lockfile (103 `darwin` entries present; the only `os:` restrictions are per-platform optional binaries).
- **Paths/config are portable**: `src/core/shared/paths.ts:21-38` — `SUDO_AI_HOME` → else cwd; `DATA_DIR` env override; no `/root/` hardcodes in the resolution layer (the file's header documents the old hardcode was removed). Config loads from `<root>/config/sudo-ai.json5` (`src/core/config/loader.ts:35`), which the tarball ships (`package/config/sudo-ai.json5`), plus `config/.env`.
- **Plain-node run mode exists**: `sudo-ai start` (foreground) / `start -d` (detached daemon), `stop`, `status`, `doctor`, `quickstart` interactive setup wizard (`src/cli/index.ts:101-145,172,242`). pm2 is not required to run — only for the self-restart path (blocker 2). Note: README.md:41 says `sudo-ai setup`; the actual command is `quickstart` (doc bug).
- **Keyless boot**: no fatal boot gate on LLM keys was found in `src/cli.ts`; `doctor`/`scan` only warn (`src/cli/commands/scan.ts:69`, `doctor.ts:90-92`). Local embeddings/STT/TTS are keyless; a fully-local brain is possible via the Ollama provider (README.md:80). UNVERIFIED that boot completes cleanly with zero keys.
- **iMessage connector is a mac-ONLY feature that finally gets to run** (`src/core/channels/imessage-connector.ts:65` gates on `process.platform === 'darwin'`).
- **Sandbox teardown/profile code already knows about mac** (`sandbox-profiles.ts:218-223` maps darwin→'mac', disables Landlock at :148-150) — it just has no mac runner behind it.

---

## Minimum path to a working Mac install (today, no code changes)

1. Install Node 20+ (`brew install node@22`) — `engines: node >=20` (package.json:18-20).
2. `npm i -g @matrixx0070/sudo-ai` (Apple Silicon and Intel both covered by prebuilds above). If better-sqlite3 lacks a prebuild for your Node ABI, install Xcode CLT: `xcode-select --install`.
3. `brew install ffmpeg poppler` (voice STT + video + PDF extract tools).
4. `sudo-ai quickstart` (the interactive wizard; README's `sudo-ai setup` does not exist) — set at least one provider key, or configure Ollama for fully local.
5. **Required env for a functional agent on mac:** `SUDO_SANDBOX_DISABLE=1` (or `SUDO_EXEC_BACKEND=docker` with Docker Desktop) — otherwise every `system.exec` fails on the missing `/usr/bin/bwrap` (blocker 1). Understand this runs agent shell commands unsandboxed (docs/configuration.md:493 marks it DANGEROUS).
6. Optional: `SUDO_RESTART_CMD="..."` so self-restart/self-update can bounce the process (blocker 2); `npx playwright install chromium` to pre-warm browser tools.
7. `sudo-ai start -d`, then `curl http://127.0.0.1:18900/health` and `sudo-ai doctor`.

**Still degraded/off after these steps:** exec sandboxing (disabled entirely, or Docker-mediated), `system.monitor` (all-zero /proc metrics), `system.process` (GNU ps flags), computer-use GUI/desktop/browser control (stubs), self-restart without `SUDO_RESTART_CMD`, watchdog/cron liveness scripts (not shipped).

---

## Recommended code changes to reach "Runs with documented setup" (NOT implemented here)

1. **Platform-aware sandbox bootstrap** — `src/cli.ts` (~:767) + `src/core/sandbox/sandbox-runner.ts`: at boot, if `process.platform !== 'linux'` or `!existsSync(BWRAP_BIN)`, set the injected agent policy to `enabled:false` with a loud one-time warning (mirroring the existing `SUDO_SANDBOX_DISABLE` warning at sandbox-runner.ts:301-305). Longer-term: a `sandbox-exec` (seatbelt) backend registered via `registerExecBackend()` (`src/core/sandbox/exec-backend.ts`), which the profile flags (`useSeatbelt`, sandbox-profiles.ts:148-150) already anticipate.
2. **BSD-compatible ps** — `src/core/tools/builtin/system/process.ts:89,106` and `monitor.ts:130`: replace `--no-headers`/`--sort` with portable invocations.
3. **Darwin metrics** — `src/core/tools/builtin/system/monitor.ts`: darwin branch (`os.loadavg`, `sysctl`, `vm_stat`) or an explicit unsupported-platform result instead of silent zeros.
4. **Restart on mac** — `src/core/tools/builtin/meta/restart-helper.ts:40-45`: add a darwin branch (launchd or self-exec respawn) before the systemctl fallback; ship a launchd plist template in docs.
5. **cwd-independent sqlite-vec resolution** — `src/core/memory/db.ts:227-246`: resolve the platform package via module resolution, not `process.cwd()`.
6. **Docs** — README.md:41 (`sudo-ai setup` → `quickstart`); BOOTSTRAP.md: add a "macOS" section covering steps 3/5/6 above and poppler. Today the only mac coverage is "experimental" disclaimers (README.md:28, BOOTSTRAP.md:7, docs/cross-platform-control-guide.md:7).

---

## Axis-by-axis evidence summary

- **Native modules**: all green per lockfile (see green list). `pnpm.onlyBuiltDependencies` (package.json:186-196) already whitelists better-sqlite3/onnxruntime-node/sharp/esbuild builds for the pnpm-from-source path.
- **Linux-only assumptions**: bwrap (fatal for exec), /proc (silent zeros), GNU ps (tool errors), systemctl (restart path only), ffmpeg/poppler (per-tool). No `/root/` hardcodes in path resolution.
- **Process management**: pm2 optional for running (`sudo-ai start -d` is plain node); required only by the self-restart chain unless `SUDO_RESTART_CMD` is set.
- **Config/secrets/paths**: portable, first-run wizard exists (`quickstart`), tarball ships `config/sudo-ai.json5` + `.env.example`; data/workspace live under the install root (global node_modules dir for `npm i -g` — writable under default Homebrew prefixes; UNVERIFIED for system-owned prefixes).
- **Node/toolchain**: Node ≥20; published package needs no build/tsx (bundled ESM dist verified in tarball); from-source needs pnpm + `pnpm build` (`esbuild.config.cjs`), tsx only for `dev`.
- **Docs**: no macOS install doc exists; only "experimental" disclaimers. This file is the first.

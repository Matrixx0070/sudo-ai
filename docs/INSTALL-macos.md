# Installing SUDO-AI on macOS

Supported: Apple Silicon (arm64) and Intel (x64), macOS with Node 20+.
Status: macOS support is new. Everything below was implemented and unit-tested from source; it has not yet been exercised on physical Mac hardware — please report issues.

## Install

```bash
# 1. Node 20+ (skip if you already have it)
brew install node@22

# 2. The SUDO-AI CLI (ships prebuilt native modules for darwin-arm64 and darwin-x64)
npm i -g @matrixx0070/sudo-ai

# 3. External tool binaries used by voice/video/PDF tools
brew install ffmpeg poppler
```

If `better-sqlite3` has no prebuild for your exact Node version, install the Xcode Command Line Tools so it can compile: `xcode-select --install`.

## Configure

```bash
sudo-ai quickstart     # interactive setup wizard (agent name, model, provider keys)
```

Add at least one provider API key when prompted (or edit `config/.env` afterwards). A fully local setup is possible via the Ollama provider. Local Whisper STT, Kokoro TTS, and local embeddings run keyless on CPU (ONNX) including Apple Silicon.

Optional: `npx playwright install chromium` to pre-warm the browser tools.

## Run

```bash
sudo-ai start -d                        # detached daemon (plain node — no pm2 needed)
curl http://127.0.0.1:18900/health      # expect 200 OK
sudo-ai doctor                          # environment / config checks
sudo-ai chat                            # talk to the agent
sudo-ai stop                            # stop the daemon
```

## The exec sandbox on macOS

On Linux, the agent's `system.exec` tool runs every command inside a bubblewrap (bwrap) sandbox. On macOS there is no bwrap; SUDO-AI instead uses the native **Seatbelt** sandbox via `/usr/bin/sandbox-exec` (part of macOS). No configuration is needed — it is on by default and translates the same policy:

- deny-by-default filesystem: reads limited to system paths + the per-session workspace, writes limited to the workspace (+ `/private/tmp`)
- network blocked unless the policy allows it
- same CPU-time / file-size / process-count resource limits (the virtual-memory cap is omitted — macOS does not support `RLIMIT_AS`)

Escape hatches if a workload is broken by a Seatbelt denial:

| Env | Effect |
|---|---|
| `SUDO_SANDBOX_ALLOW_UNCONFINED=1` | macOS only: skip Seatbelt, run exec unsandboxed. Logs a loud warning on every call. |
| `SUDO_SANDBOX_DISABLE=1` | All platforms: disable sandboxing entirely (DANGEROUS). |
| `SUDO_EXEC_BACKEND=docker` | Route exec through Docker Desktop instead. |

Honesty note: the Seatbelt profile is a faithful best-effort translation of the Linux policy and is covered by unit tests, but it has **not been verified on a physical Mac**. If ordinary commands fail with sandbox denials, use `SUDO_SANDBOX_ALLOW_UNCONFINED=1` and file an issue with the failing command.

## Self-restart

The self-restart chain (`meta.service-control restart`, self-update) uses pm2 → systemctl on Linux. On a Mac, neither usually exists, so SUDO-AI reports clearly that it cannot restart itself and how to fix it, instead of failing confusingly. Options:

- `npm i -g pm2` and run under pm2 (the restart chain then works as on Linux), or
- set `SUDO_RESTART_CMD` to your own restart command (e.g. a `launchctl kickstart -k` target for a launchd service, or a script that does `sudo-ai stop && sudo-ai start -d`), or
- just restart manually: `sudo-ai stop && sudo-ai start -d`.

## What works vs. degraded on macOS

Works out of the box:

- Daemon, web chat SPA, Telegram/channels, browser tools (Playwright), memory/RAG (sqlite-vec ships darwin builds), local STT/TTS/embeddings, document/media tools (after `brew install ffmpeg poppler`)
- `system.exec` (Seatbelt-sandboxed, see above)
- `system.process` and `system.monitor` (BSD `ps` + `node:os` metric sources)
- iMessage connector — a macOS-only feature that only runs here

Degraded / unavailable (reported honestly by the tools, not silent zeros):

- `system.monitor` per-device disk and per-interface network byte counters (no `/proc` equivalent) — labeled `unavailable`
- Process thread counts in `system.process info` — unavailable off Linux
- Self-restart without pm2 or `SUDO_RESTART_CMD` (see above)
- Computer-use GUI/desktop/browser *control* backends (`control.gui` etc.) remain experimental stubs on macOS (the Playwright `browser.*` tools are a separate, working path)
- Watchdog/cron liveness shell scripts are Linux/pm2-flavored and are not shipped in the npm package

See `docs/MACOS_READINESS.md` for the full audit this support work was based on.

# Google Drive Setup (Drive Roadmap — Foundation)

This wires sudo-ai's Google Drive memory substrate (see `docs/DRIVE_ROADMAP_STATUS.md`).
The layer is **opt-in** (`SUDO_GDRIVE=1`) and all Drive I/O runs as background jobs —
the agent loop never waits on Drive.

## Auth mode decision (already made)

**Default: service account.** Headless, no consent-screen token expiry, survives
restarts and machines without a browser.

Tradeoffs to know:

- Files the service account (SA) creates are **owned by the SA**, not by you, and
  count against the SA's own fixed **15 GB quota**. That is ample for a
  text-dominant memory substrate, but don't point large binary pipelines at it.
- You see the files because the `sudo-ai/` folder is shared with the SA inside a
  folder you own; you retain visibility and can revoke the SA at any time.

An OAuth **loopback** mode also exists (`GDRIVE_AUTH_MODE=oauth`) for portability.
It is not the default. Never the deprecated `oob` flow. Caveat: while a GCP consent
screen is in **Testing** status, refresh tokens expire after **7 days** — publish the
app (internal is fine) before relying on it.

## HUMAN: one-time GCP setup (~10 minutes)

1. **Create a GCP project**
   1. Open <https://console.cloud.google.com/projectcreate>.
   2. Name: `sudo-ai-drive` (anything works). Create, then make sure it's the
      selected project in the top bar.

2. **Enable the two APIs**
   1. Open <https://console.cloud.google.com/apis/library>.
   2. Search **Google Drive API** → Enable.
   3. Search **Google Sheets API** → Enable.

3. **Create the service account**
   1. Open <https://console.cloud.google.com/iam-admin/serviceaccounts> → **Create service account**.
   2. Name: `sudo-ai`. No project roles needed (Drive access comes from folder
      sharing, not IAM). Create and continue → Done.
   3. Note the SA email, e.g. `sudo-ai@sudo-ai-drive.iam.gserviceaccount.com`.

4. **Create + download the JSON key**
   1. Click the SA → **Keys** tab → Add key → Create new key → **JSON** → Create.
   2. A JSON file downloads. Move it **outside the repo**, e.g.:
      ```bash
      mkdir -p ~/.sudo-ai
      mv ~/Downloads/sudo-ai-drive-*.json ~/.sudo-ai/gdrive-sa-key.json
      chmod 600 ~/.sudo-ai/gdrive-sa-key.json
      ```
   3. Never commit, paste, or upload this file anywhere.

5. **Create and share the Drive folder**
   1. In your own Google Drive, create a folder named `sudo-ai`.
   2. Right-click → Share → add the SA email from step 3 as **Editor**.
   3. Open the folder; copy the **folder id** — the last path segment of the URL
      (`https://drive.google.com/drive/folders/<THIS_PART>`).

6. **Configure sudo-ai** — in `config/.env`:
   ```bash
   SUDO_GDRIVE=1
   GOOGLE_APPLICATION_CREDENTIALS=/root/.sudo-ai/gdrive-sa-key.json
   GDRIVE_ROOT_FOLDER_ID=<folder id from step 5>
   ```

That's everything only a human can do. Everything below is automatic.

## What happens on next boot

- Config is validated **fail-fast**: `SUDO_GDRIVE=1` with a missing key file or
  root folder id aborts startup with an actionable error.
- On the first background job fire, the canonical folder tree is bootstrapped
  idempotently under `sudo-ai/` (manifest/, memory/, knowledge/, skills/, brains/,
  tasks/, datasets/, evals/, ops/) and the folder ids are cached in
  `data/gdrive/folder-ids.json` (0600) — a warm cache costs zero Drive calls.
- A `Google Drive Heartbeat` cron job (default every 5 min, `GDRIVE_HEARTBEAT_MS`)
  updates `ops/heartbeat.json` in place — the dead-man's-switch signal for F34.
- Every Drive job emits a hash-chained audit row (`data/audit.db`, actor `gdrive`).

## Manual smoke test (after the HUMAN steps)

```bash
# 1. Boot with the flag on and watch for:
#      "gdrive heartbeat scheduled"  then, within one interval,
#      "gdrive runtime initialized"  (first fire bootstraps the tree)
pnpm dev:server

# 2. Verify in Drive: the sudo-ai/ folder now contains the canonical tree and
#    sudo-ai/ops/heartbeat.json updates its modifiedTime every ~5 minutes.

# 3. Verify the audit trail locally:
sqlite3 data/audit.db "SELECT action, outcome, timestamp FROM audit_log WHERE actor='gdrive' ORDER BY timestamp DESC LIMIT 5;"
```

## Rate limiting & degradation

All Drive/Sheets calls share one token bucket (default 5 req/s, burst 10) with two
priority lanes — interactive work always preempts background sync. Retryable errors
(403-rate, 429, 5xx, network) back off exponentially with full jitter, max 5 retries.
Drive being down is invisible to the agent loop: jobs fail, audit the failure, and
retry on their next cron tick.

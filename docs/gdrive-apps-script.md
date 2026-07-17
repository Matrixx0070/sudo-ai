# Apps Script Push Pings (F21, transport b)

Zero-infra push path: a Google Apps Script on a 1-minute time trigger checks the
watched Drive surfaces and POSTs an HMAC-signed ping to sudo-ai's existing
inbound-webhook gateway. Polling stays on as backstop. (Transport (a), native
`changes.watch` channels, needs public HTTPS + domain verification — deliberately
not used.)

## HUMAN: deploy (~5 minutes)

1. Open <https://script.google.com> → New project → paste the script below.
2. Project Settings → Script Properties: add
   - `SECRET` — output of `openssl rand -hex 32` (also goes in the hook config below)
   - `ENDPOINT` — `https://<your-gateway>/v1/hooks/gdrive-push`
   - `INBOX_FOLDER_ID` — the id of `sudo-ai/knowledge/inbox`
   - `PANEL_SHEET_ID` — the control-panel spreadsheet id (from `data/gdrive/control-panel-id.json`)
3. Triggers → Add trigger → `tick` → time-driven → every minute.
4. In `config/webhooks.json5`, add a hook (uses the existing Spec-4 gateway):
   ```json5
   {
     id: 'gdrive-push',
     auth: { mode: 'hmac', secret: '<same SECRET>' },
     // The hook turn just runs the matching gdrive job via the ping payload.
   }
   ```

## Script

```javascript
const props = PropertiesService.getScriptProperties();

function tick() {
  const state = PropertiesService.getScriptProperties();
  // Inbox: any file newer than the last tick?
  const inbox = DriveApp.getFolderById(props.getProperty('INBOX_FOLDER_ID'));
  const last = Number(state.getProperty('LAST_TICK') || 0);
  let sendInbox = false;
  const files = inbox.getFiles();
  while (files.hasNext()) {
    if (files.next().getLastUpdated().getTime() > last) { sendInbox = true; break; }
  }
  // Control panel: PAUSE cell or any Config edit newer than last tick?
  const sheetFile = DriveApp.getFileById(props.getProperty('PANEL_SHEET_ID'));
  const sendPanel = sheetFile.getLastUpdated().getTime() > last;

  if (sendInbox) ping('inbox');
  if (sendPanel) ping('control-panel');
  state.setProperty('LAST_TICK', String(Date.now()));
}

function ping(kind) {
  const ts = Date.now();
  const secret = props.getProperty('SECRET');
  const sigBytes = Utilities.computeHmacSha256Signature(kind + ':' + ts, secret);
  const signature = sigBytes.map(function(b){ return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
  UrlFetchApp.fetch(props.getProperty('ENDPOINT'), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ kind: kind, ts: ts, signature: signature }),
    muteHttpExceptions: true,
  });
}
```

## Harness side

`src/core/gdrive/push.ts` — `handlePushPing({kind, ts}, signature, secret, runEvent)`
verifies the HMAC (timing-safe) and freshness (±5 min), then dispatches the
matching `gdrive:*` job immediately. Forged or stale pings are rejected and
logged. Wire it from the `gdrive-push` hook handler with a closure over the
cron event dispatch.

## F34 additions (Phase 7 — same Script grows into the pacemaker)

The dead-man's switch, pin rotation, and morning digest land in this same
Script later: read `ops/heartbeat.json`, alert when `now - lastBeat` exceeds
the threshold, rotate `keepRevisionForever` pins, and email the daily digest.

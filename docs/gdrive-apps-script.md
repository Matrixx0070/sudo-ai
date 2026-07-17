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

## F34 — the pacemaker + dead-man's switch (Phase 7)

Add these to the SAME Script project. They run even when every sudo-ai host is
off — infrastructure that outlives the process it guards.

Extra Script Properties: `ALERT_EMAIL` (Frank's), `HEARTBEAT_FILE_ID` (id of
`sudo-ai/ops/heartbeat.json`), `HEARTBEAT_THRESHOLD_MIN` (e.g. `20`),
`MANIFEST_FILE_ID` (id of `sudo-ai/manifest/manifest.json`),
`REPORTS_FOLDER_ID` (id of `sudo-ai/ops/reports`).

Triggers: `deadMan` every 10 minutes; `morningDigest` daily 7–8am;
`rotatePins` daily.

```javascript
function deadMan() {
  var p = PropertiesService.getScriptProperties();
  var hb = JSON.parse(DriveApp.getFileById(p.getProperty('HEARTBEAT_FILE_ID')).getBlob().getDataAsString());
  var ageMin = (Date.now() - new Date(hb.lastBeat).getTime()) / 60000;
  var threshold = Number(p.getProperty('HEARTBEAT_THRESHOLD_MIN') || 20);
  var state = PropertiesService.getScriptProperties();
  if (ageMin > threshold) {
    if (state.getProperty('DEADMAN_FIRED') !== '1') {
      MailApp.sendEmail(p.getProperty('ALERT_EMAIL'), '⚠️ sudo-ai heartbeat lost',
        'Last beat: ' + hb.lastBeat + ' (' + Math.round(ageMin) + ' min ago) from ' + hb.host + '. All hosts may be down.');
      state.setProperty('DEADMAN_FIRED', '1');
    }
  } else if (state.getProperty('DEADMAN_FIRED') === '1') {
    MailApp.sendEmail(p.getProperty('ALERT_EMAIL'), '✅ sudo-ai heartbeat recovered', 'Beating again as of ' + hb.lastBeat);
    state.deleteProperty('DEADMAN_FIRED');
  }
}

function morningDigest() {
  var p = PropertiesService.getScriptProperties();
  var folder = DriveApp.getFolderById(p.getProperty('REPORTS_FOLDER_ID'));
  var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  var it = folder.getFilesByName('daily-' + yesterday);
  var body = it.hasNext() ? ('Daily report: ' + it.next().getUrl()) : 'No daily report found for ' + yesterday;
  MailApp.sendEmail(p.getProperty('ALERT_EMAIL'), 'sudo-ai morning digest ' + yesterday, body);
}

function rotatePins() {
  // Cap-aware keepForever rotation on the manifest (Drive caps ~200 pins/file).
  var p = PropertiesService.getScriptProperties();
  var fileId = p.getProperty('MANIFEST_FILE_ID');
  var revs = Drive.Revisions.list(fileId, {fields: 'revisions(id,keepForever,modifiedTime)'}).revisions || [];
  var pinned = revs.filter(function(r){ return r.keepForever; });
  var MAX = 25;
  for (var i = 0; i < pinned.length - MAX; i++) {
    Drive.Revisions.update({keepForever: false}, fileId, pinned[i].id);
  }
}
```

`rotatePins` needs the **Drive Advanced Service** enabled in the Script
(Services → Drive API).

**Done-when drill:** stop all sudo-ai hosts; within `HEARTBEAT_THRESHOLD_MIN`
+10min the alert email arrives; restart; the recovery email arrives.

## NotebookLM annex — rituals digest extension (F34 → E3)

The morning digest gains an overdue-rituals line. The harness writes the ritual
status to `sudo-ai/notebooklm/rituals/ritual-manifest` (a Doc) and a local
`data/notebooklm/rituals-status.json`; the Script reads the manifest Doc.

**HUMAN: redeploy** — add this function to the pacemaker Script and a
`RITUALS_DOC_ID` Script Property (fileId of the `ritual-manifest` Doc), then
extend the `morningDigest` trigger body to also call `ritualsDigestLine()`.

```javascript
// Appends an overdue-rituals line to the morning digest. The manifest Doc
// carries the Tier-1 budget line + the ritual table; we surface the budget
// status and flag if it went over. (Full overdue tracking = the harness ticks
// the Rituals scorecard tab; this is the nudge.)
function ritualsDigestLine() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('RITUALS_DOC_ID');
  if (!id) return '';
  try {
    var text = DocumentApp.openById(id).getBody().getText();
    var m = text.match(/Tier-1 \(core\) weekly budget: [^\n]+/);
    return m ? ('\nRituals: ' + m[0]) : '';
  } catch (e) { return ''; }
}

// In morningDigest(), change the MailApp.sendEmail body to:
//   body + ritualsDigestLine()
```

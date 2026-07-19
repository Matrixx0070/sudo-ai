/**
 * @file gateway/dashboard-sessions.ts
 * @description BO9 / scorecard-S8 — the inline admin dashboard's Sessions table
 * fragment (HTML panel + client script), kept out of the already-large
 * `dashboard-html.ts` template (mirrors BO8's `dashboard-usage.ts`).
 * `renderDashboardHtml()` interpolates the two exported strings.
 *
 * The client script relies ONLY on helpers already defined in the parent
 * dashboard scope (`apiFetch`, `apiPost`, `esc`, `token`), so it must be
 * interpolated inside the same `<script>` IIFE. It manages its own fetch + state
 * and lives OUTSIDE `#dashboard`, so the 30 s poll re-render never tears it down.
 *
 * Backed by GET /v1/admin/system/sessions (list) + POST
 * .../sessions/{fork,archive} (`src/core/api/admin/system-sessions.handler.ts`),
 * over the pure roll-up in `src/core/sessions/sessions-rollup.ts`.
 *
 * BEAT-OPENCLAW: the Archive action opens a confirm() dialog and only sends the
 * request with confirm=true after the operator agrees — OpenClaw archives
 * instantly with no confirm (their defect). Fork copies history to a new session
 * (additive).
 *
 * The script contains NO backticks and NO `${` so it survives nesting inside the
 * parent template literal.
 */

/** Sessions panel markup — inserted just after the Usage panel. */
export const SESSIONS_PANEL_HTML = `
<!-- BO9 / S8 sessions table. OUTSIDE #dashboard so the 30s poll re-render never
     tears down toggle state or the loaded rows. -->
<div class="section-head" style="margin-top:20px">Sessions (context fill &middot; fork &middot; archive)</div>
<div id="sessions-panel" class="wide-panel">
  <div id="sessions-controls"></div>
  <div id="sessions-summary" class="panel-sub" style="margin-top:8px">Loading sessions&hellip;</div>
  <div id="sessions-table" style="margin-top:12px;overflow-x:auto"></div>
</div>`;

/**
 * Sessions client script — interpolated INSIDE the dashboard `<script>` IIFE so
 * it can call the parent scope's `apiFetch`, `apiPost`, `esc`, and read `token`.
 */
export const SESSIONS_SCRIPT = `
// -------------------------------------------------------------------------
// BO9 / S8 — Sessions table (key/kind/state/context-fill/updated/messages +
// Fork and Archive-WITH-CONFIRM). Independent of the dashboard poll: its own
// fetch + state so a control click never triggers a full-dashboard re-render.
// -------------------------------------------------------------------------
var sessState   = 'active';  // active | archived | all
var sessSort    = 'updated'; // updated | tokens | messages | key
var sessGroupBy = 'none';    // none | kind
var lastSessions = null;

function sessFmtTok(n){
  n = Number(n||0);
  if(n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if(n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if(n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function sessFmtAge(ms){
  ms = Number(ms||0);
  var s = Math.floor(ms/1000);
  if(s < 45) return 'now';
  var m = Math.floor(s/60);
  if(m < 60) return m + 'm ago';
  var h = Math.floor(m/60);
  if(h < 24) return h + 'h ago';
  return Math.floor(h/24) + 'd ago';
}
function sessStatePill(st){
  var cls = st === 'active' ? 'pill-green' : (st === 'archived' ? 'pill-grey' : 'pill-yellow');
  return '<span class="pill ' + cls + '">' + esc(st) + '</span>';
}

function sessBtn(label, active, onclick){
  var b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'margin:0 4px 4px 0;background:' + (active?'#238636':'#21262d') +
    ';color:' + (active?'#fff':'#c9d1d9') + ';border:1px solid ' + (active?'#238636':'#30363d') +
    ';border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer';
  b.onclick = onclick;
  return b;
}

function renderSessControls(){
  var box = document.getElementById('sessions-controls');
  if(!box) return;
  box.innerHTML = '';
  function group(label, opts, cur, set){
    var wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-block;margin-right:14px';
    var lb = document.createElement('span');
    lb.textContent = label + ' ';
    lb.style.cssText = 'color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-right:4px';
    wrap.appendChild(lb);
    opts.forEach(function(o){ wrap.appendChild(sessBtn(o.label, cur === o.val, function(){ set(o.val); })); });
    return wrap;
  }
  box.appendChild(group('State', [{label:'Active',val:'active'},{label:'Archived',val:'archived'},{label:'All',val:'all'}], sessState,
    function(v){ sessState = v; loadSessions(); }));
  box.appendChild(group('Sort', [{label:'Updated',val:'updated'},{label:'Tokens',val:'tokens'},{label:'Msgs',val:'messages'},{label:'Key',val:'key'}], sessSort,
    function(v){ sessSort = v; loadSessions(); }));
  box.appendChild(group('Group', [{label:'None',val:'none'},{label:'Kind',val:'kind'}], sessGroupBy,
    function(v){ sessGroupBy = v; loadSessions(); }));
  var refresh = sessBtn('Refresh', false, function(){ loadSessions(); });
  box.appendChild(refresh);
}

function loadSessions(){
  renderSessControls();
  var sum = document.getElementById('sessions-summary');
  if(sum) sum.textContent = 'Loading sessions...';
  apiFetch('/v1/admin/system/sessions?state=' + encodeURIComponent(sessState) +
    '&sort=' + encodeURIComponent(sessSort) + '&groupBy=' + encodeURIComponent(sessGroupBy),
    function(err, data){
      if(err || !data || !data.ok){
        if(sum) sum.textContent = 'Sessions unavailable' + (err ? ' (' + err.message + ')' : '');
        return;
      }
      lastSessions = data.data;
      renderSessions();
    });
}

function sessContextCell(r){
  var pct = Number(r.contextPct||0);
  var w = Math.max(1, Math.min(100, pct));
  var col = pct >= 90 ? '#f85149' : (pct >= 70 ? '#d29922' : '#3fb950');
  var est = r.tokensEstimated ? ' ~' : ' ';
  var label = est + sessFmtTok(r.usedTokens) + ' / ' + sessFmtTok(r.contextWindow) + ' (' + pct.toFixed(1) + '%)';
  var bar = '<span style="display:inline-block;height:8px;width:90px;background:#21262d;border-radius:4px;overflow:hidden;vertical-align:middle">' +
    '<span style="display:inline-block;height:100%;width:' + w + '%;background:' + col + '"></span></span>';
  return '<div style="display:flex;align-items:center;gap:6px">' + bar +
    '<span style="color:#c9d1d9;font-size:11px;font-variant-numeric:tabular-nums">' + esc(label) + '</span></div>';
}

function sessActionCell(r){
  var td = document.createElement('td');
  td.style.cssText = 'padding:6px 8px;white-space:nowrap';
  var fork = sessBtn('Fork', false, function(){
    fork.disabled = true; fork.textContent = 'Forking...';
    apiPost('/v1/admin/system/sessions/fork', { id: r.id }, function(err, resp){
      if(err || !resp || !resp.ok){ alert('Fork failed' + (err ? ': ' + err.message : (resp && resp.error ? ': ' + (resp.error.message||resp.error) : ''))); fork.disabled = false; fork.textContent = 'Fork'; return; }
      alert('Forked to ' + resp.id + ' (' + (resp.messagesCopied||0) + ' messages copied). Original unchanged.');
      loadSessions();
    });
  });
  td.appendChild(fork);
  if(r.state !== 'archived'){
    var arch = sessBtn('Archive', false, function(){
      // BEAT-OPENCLAW: require explicit confirm before archiving.
      var okConfirm = window.confirm('Archive session ' + r.key + '?\\n\\nThis marks it archived (reversible). Continue?');
      if(!okConfirm) return; // no-confirm -> nothing is sent
      arch.disabled = true; arch.textContent = 'Archiving...';
      apiPost('/v1/admin/system/sessions/archive', { id: r.id, confirm: true }, function(err, resp){
        if(err || !resp || !resp.ok){ alert('Archive failed' + (err ? ': ' + err.message : '')); arch.disabled = false; arch.textContent = 'Archive'; return; }
        loadSessions();
      });
    });
    arch.style.borderColor = '#9e6a03';
    td.appendChild(arch);
  }
  return td;
}

function sessRowEl(r){
  var tr = document.createElement('tr');
  tr.style.cssText = 'border-bottom:1px solid #21262d';
  function cell(html, css){
    var td = document.createElement('td');
    td.style.cssText = 'padding:6px 8px;' + (css||'');
    td.innerHTML = html;
    return td;
  }
  tr.appendChild(cell('<span style="color:#58a6ff">' + esc(r.key) + '</span>' +
    (r.model ? '<div class="panel-sub" style="font-size:10px">' + esc(r.model) + '</div>' : ''), 'max-width:260px;word-break:break-all'));
  tr.appendChild(cell('<span class="pill pill-blue">' + esc(r.kind) + '</span>'));
  tr.appendChild(cell(sessStatePill(r.state)));
  tr.appendChild(cell(sessContextCell(r), 'min-width:200px'));
  tr.appendChild(cell('<span style="color:#8b949e;font-size:11px">' + esc(sessFmtAge(r.ageMs)) + '</span>'));
  tr.appendChild(cell('<span style="color:#e6edf3;font-variant-numeric:tabular-nums">' + esc(String(r.messageCount||0)) + '</span>', 'text-align:right'));
  tr.appendChild(sessActionCell(r));
  return tr;
}

function sessTableEl(rows){
  var tbl = document.createElement('table');
  tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px';
  var thead = document.createElement('thead');
  thead.innerHTML = '<tr style="text-align:left;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1px">' +
    '<th style="padding:6px 8px">Key</th><th style="padding:6px 8px">Kind</th><th style="padding:6px 8px">State</th>' +
    '<th style="padding:6px 8px">Context fill</th><th style="padding:6px 8px">Updated</th>' +
    '<th style="padding:6px 8px;text-align:right">Msgs</th><th style="padding:6px 8px">Actions</th></tr>';
  tbl.appendChild(thead);
  var tbody = document.createElement('tbody');
  rows.forEach(function(r){ tbody.appendChild(sessRowEl(r)); });
  tbl.appendChild(tbody);
  return tbl;
}

function renderSessions(){
  renderSessControls();
  var u = lastSessions;
  var sum = document.getElementById('sessions-summary');
  var host = document.getElementById('sessions-table');
  if(!u || !host){ return; }
  var t = u.totals || {};
  if(sum){
    sum.innerHTML = '<b style="color:#e6edf3">' + esc(String(u.count||0)) + '</b> sessions \\u00b7 ' +
      esc(String(t.active||0)) + ' active \\u00b7 ' + esc(String(t.archived||0)) + ' archived \\u00b7 ' +
      '<span style="color:#3fb950">' + sessFmtTok(t.usedTokens||0) + ' tokens</span> \\u00b7 avg fill ' +
      Number(t.avgContextPct||0).toFixed(1) + '%';
  }
  host.innerHTML = '';
  if(!u.count){ host.innerHTML = '<div class="panel-sub">No sessions in this view.</div>'; return; }
  if(u.groupBy === 'kind' && u.groups && u.groups.length){
    u.groups.forEach(function(g){
      var head = document.createElement('div');
      head.style.cssText = 'color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:12px 0 4px';
      head.innerHTML = esc(g.kind) + ' <span style="color:#6e7681">(' + esc(String(g.count)) + ' \\u00b7 ' + sessFmtTok(g.usedTokens) + ' tok)</span>';
      host.appendChild(head);
      host.appendChild(sessTableEl(g.rows || []));
    });
  } else {
    host.appendChild(sessTableEl(u.rows || []));
  }
}

if(token){
  loadSessions();
}
`;

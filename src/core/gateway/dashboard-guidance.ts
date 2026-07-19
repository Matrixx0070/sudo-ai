/**
 * @file gateway/dashboard-guidance.ts
 * @description BO10 / scorecard-S10 — the inline admin dashboard's guidance-file
 * viewer + gated editor fragment (HTML panel + client script), kept out of the
 * already-large `dashboard-html.ts` template (mirrors BO8/BO9).
 * `renderDashboardHtml()` interpolates the two exported strings.
 *
 * The client script relies ONLY on helpers already defined in the parent
 * dashboard scope (`apiFetch`, `apiPost`, `esc`, `token`), so it is interpolated
 * inside the same `<script>` IIFE. It manages its own fetch + state and lives
 * OUTSIDE `#dashboard`, so the 30s poll re-render never tears it down.
 *
 * Backed by GET /v1/admin/system/guidance (list), GET .../guidance/file (read),
 * POST .../guidance/file (gated audited write) —
 * `src/core/api/admin/system-guidance.handler.ts`.
 *
 * INVARIANT 4 (beat-OpenClaw stop-condition surface): FROZEN files render with a
 * lock icon and NO edit box / NO Save button — the viewer shows content, the UI
 * exposes no write path. Only non-frozen files get the textarea + Save. The write
 * endpoint hard-rejects frozen files regardless, so a bypassed UI still fails.
 *
 * The script contains NO backticks and NO `${` so it survives nesting inside the
 * parent template literal.
 */

/** Guidance panel markup — inserted after the Sessions panel. */
export const GUIDANCE_PANEL_HTML = `
<!-- BO10 / S10 guidance-file viewer + gated editor. OUTSIDE #dashboard so the
     30s poll re-render never tears down the loaded file or edit state. -->
<div class="section-head" style="margin-top:20px">Guidance files (view &middot; frozen read-only &middot; audited edit)</div>
<div id="guidance-panel" class="wide-panel">
  <div id="guidance-summary" class="panel-sub">Loading guidance files&hellip;</div>
  <div style="display:flex;gap:14px;margin-top:12px;flex-wrap:wrap">
    <div id="guidance-list" style="min-width:200px"></div>
    <div id="guidance-view" style="flex:1;min-width:320px"></div>
  </div>
</div>`;

/**
 * Guidance client script — interpolated INSIDE the dashboard `<script>` IIFE so
 * it can call the parent scope's `apiFetch`, `apiPost`, `esc`, and read `token`.
 */
export const GUIDANCE_SCRIPT = `
// -------------------------------------------------------------------------
// BO10 / S10 — Guidance-file viewer + gated audited editor. Frozen files
// (PROTECTED_PATHS + identity/constitution surfaces) are READ-ONLY: a lock
// icon, no textarea, no Save. Non-frozen files get an audited edit box.
// Independent of the dashboard poll (own fetch + state).
// -------------------------------------------------------------------------
var guidanceFiles = null;
var guidanceSelected = null;

function guidFmtBytes(n){
  n = Number(n||0);
  if(n >= 1024) return (n/1024).toFixed(1) + 'K';
  return String(n) + 'B';
}

function loadGuidance(){
  var sum = document.getElementById('guidance-summary');
  if(sum) sum.textContent = 'Loading guidance files...';
  apiFetch('/v1/admin/system/guidance', function(err, data){
    if(err || !data || !data.ok){
      if(sum) sum.textContent = 'Guidance unavailable' + (err ? ' (' + err.message + ')' : '');
      return;
    }
    guidanceFiles = data.data;
    renderGuidanceList();
  });
}

function renderGuidanceList(){
  var g = guidanceFiles;
  var sum = document.getElementById('guidance-summary');
  var list = document.getElementById('guidance-list');
  if(!g || !list) return;
  if(sum){
    sum.innerHTML = '<b style="color:#e6edf3">' + esc(String(g.count||0)) + '</b> files \\u00b7 ' +
      esc(String(g.editableCount||0)) + ' editable \\u00b7 ' +
      '<span style="color:#8b949e">' + esc(String(g.frozenCount||0)) + ' frozen (read-only)</span>';
  }
  list.innerHTML = '';
  (g.files||[]).forEach(function(f){
    var row = document.createElement('div');
    var isSel = guidanceSelected && guidanceSelected.name === f.name;
    row.style.cssText = 'padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px;margin-bottom:2px;' +
      (isSel ? 'background:#161b22;border:1px solid #30363d' : 'border:1px solid transparent');
    var lock = f.frozen ? '<span title="Frozen — read-only" style="color:#d29922">\\ud83d\\udd12 </span>' : '';
    var miss = f.exists ? '' : '<span style="color:#6e7681"> (missing)</span>';
    row.innerHTML = lock + '<span style="color:' + (f.frozen ? '#8b949e' : '#58a6ff') + '">' + esc(f.label) + '</span>' +
      miss + '<div class="panel-sub" style="font-size:10px">' + guidFmtBytes(f.bytes) + '</div>';
    row.onclick = function(){ openGuidance(f); };
    list.appendChild(row);
  });
}

function openGuidance(f){
  guidanceSelected = f;
  renderGuidanceList();
  var view = document.getElementById('guidance-view');
  if(view) view.innerHTML = '<div class="panel-sub">Loading ' + esc(f.label) + '...</div>';
  apiFetch('/v1/admin/system/guidance/file?name=' + encodeURIComponent(f.name), function(err, data){
    if(err || !data || !data.ok){
      if(view) view.innerHTML = '<div class="panel-sub">Failed to read ' + esc(f.label) + '</div>';
      return;
    }
    renderGuidanceView(data.data);
  });
}

function renderGuidanceView(r){
  var view = document.getElementById('guidance-view');
  if(!view) return;
  view.innerHTML = '';
  var head = document.createElement('div');
  var lock = r.frozen ? '<span style="color:#d29922">\\ud83d\\udd12 frozen \\u00b7 read-only</span>' : '<span style="color:#3fb950">editable</span>';
  head.innerHTML = '<b style="color:#e6edf3">' + esc(r.label) + '</b> ' +
    '<span class="panel-sub" style="font-size:11px">' + esc(r.relPath) + ' \\u00b7 ' + lock + '</span>';
  view.appendChild(head);

  if(!r.frozen){
    // Editable file — textarea + audited Save.
    var ta = document.createElement('textarea');
    ta.value = r.content || '';
    ta.style.cssText = 'width:100%;height:280px;margin-top:8px;background:#0d1117;color:#c9d1d9;' +
      'border:1px solid #30363d;border-radius:6px;padding:8px;font:12px monospace;box-sizing:border-box';
    view.appendChild(ta);
    var msg = document.createElement('div');
    msg.className = 'panel-sub';
    msg.style.cssText = 'margin-top:6px;font-size:11px';
    var save = document.createElement('button');
    save.textContent = 'Save (audited)';
    save.style.cssText = 'margin-top:8px;background:#238636;color:#fff;border:1px solid #238636;' +
      'border-radius:6px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer';
    save.onclick = function(){
      save.disabled = true; save.textContent = 'Saving...';
      apiPost('/v1/admin/system/guidance/file', { name: r.name, content: ta.value }, function(err, resp){
        save.disabled = false; save.textContent = 'Save (audited)';
        if(err || !resp || !resp.ok){
          msg.style.color = '#f85149';
          msg.textContent = 'Save failed' + (resp && resp.error ? ': ' + (resp.error.message||resp.error) : (err ? ': ' + err.message : ''));
          return;
        }
        var a = resp.data || {};
        msg.style.color = '#3fb950';
        msg.textContent = 'Saved \\u00b7 audited ' + String(a.configHashBefore||'').slice(0,8) +
          ' \\u2192 ' + String(a.configHashAfter||'').slice(0,8) + (a.bakPath ? ' \\u00b7 .bak written' : '');
        loadGuidance();
      });
    };
    view.appendChild(save);
    view.appendChild(msg);
  } else {
    // Frozen file — read-only preview, NO edit box, NO Save.
    var pre = document.createElement('pre');
    pre.textContent = r.exists ? (r.content || '') : '(file not present)';
    pre.style.cssText = 'width:100%;max-height:280px;overflow:auto;margin-top:8px;background:#0d1117;' +
      'color:#8b949e;border:1px solid #30363d;border-radius:6px;padding:8px;font:12px monospace;' +
      'white-space:pre-wrap;box-sizing:border-box';
    view.appendChild(pre);
    var note = document.createElement('div');
    note.className = 'panel-sub';
    note.style.cssText = 'margin-top:6px;font-size:11px;color:#d29922';
    note.textContent = 'This is a frozen identity/constitution surface — read-only, no write path (invariant 4).';
    view.appendChild(note);
  }
}

if(token){
  loadGuidance();
}
`;

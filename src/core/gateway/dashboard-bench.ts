/**
 * @file gateway/dashboard-bench.ts
 * @description AL7.1 leftover + AL4.5 telemetry — the inline admin
 * dashboard's Bench & Graph Runs panel (HTML fragment + client script),
 * following the dashboard-usage.ts pattern: two exported strings that
 * renderDashboardHtml() interpolates.
 *
 * The client script relies ONLY on parent-scope helpers (`apiFetch`, `esc`)
 * and contains no backticks or `${`, so it survives nesting in the parent
 * template literal. It lives OUTSIDE `#dashboard` — the 30 s poll re-render
 * never tears it down; it fetches once on load with a manual reload button.
 *
 * Backed by GET /v1/admin/bench (bench-routes.ts) and
 * GET /v1/admin/graph-runs (+ /approvals) (graph-runs-routes.ts). Either
 * endpoint being unregistered degrades to a per-section notice.
 */

/** Bench & graph-runs panel markup — inserted after the `#dashboard` container. */
export const BENCH_PANEL_HTML = `
<div class="section-head" style="margin-top:20px">Bench &amp; Graph Runs</div>
<div id="bench-panel" class="wide-panel">
  <div id="bench-runs" class="panel-sub">Loading bench runs&hellip;</div>
  <div id="eval-sandbox-runs" class="panel-sub" style="margin-top:12px">Loading eval-sandbox runs&hellip;</div>
  <div id="graph-runs" class="panel-sub" style="margin-top:12px">Loading graph runs&hellip;</div>
  <div id="graph-approvals" class="panel-sub" style="margin-top:12px"></div>
  <div id="al9-generations" class="panel-sub" style="margin-top:12px"></div>
  <button id="bench-reload" style="margin-top:10px;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">Reload</button>
</div>`;

/** Bench client script — interpolated inside the dashboard <script> IIFE. */
export const BENCH_SCRIPT = `
// -------------------------------------------------------------------------
// Bench & Graph Runs panel (AL7.1 + AL4.5). Own fetch/state, outside the
// 30s dashboard poll. Generic row rendering so store-shape drift never
// blanks the panel.
// -------------------------------------------------------------------------
function alRowsTable(list, cols){
  if(!list || !list.length) return '<span style="color:#8b949e">none</span>';
  var h = '<table style="width:100%;border-collapse:collapse;font-size:12px"><tr>';
  cols.forEach(function(c){ h += '<th style="text-align:left;color:#8b949e;padding:2px 8px 2px 0">' + esc(c) + '</th>'; });
  h += '</tr>';
  list.slice(0, 10).forEach(function(row){
    h += '<tr>';
    cols.forEach(function(c){
      var v = row && row[c];
      if(v === undefined || v === null) v = '';
      if(typeof v === 'object') v = JSON.stringify(v);
      h += '<td style="padding:2px 8px 2px 0;border-top:1px solid #21262d">' + esc(String(v).slice(0, 60)) + '</td>';
    });
    h += '</tr>';
  });
  h += '</table>';
  return h;
}
function alSection(id, title, html){
  var el = document.getElementById(id);
  if(el) el.innerHTML = '<div style="color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">' + title + '</div>' + html;
}
function alPickCols(list, preferred){
  if(!list || !list.length) return preferred;
  var have = Object.keys(list[0] || {});
  var cols = preferred.filter(function(c){ return have.indexOf(c) >= 0; });
  return cols.length ? cols : have.slice(0, 5);
}
function loadBenchPanel(){
  apiFetch('/v1/admin/bench', function(err, data){
    if(err){ alSection('bench-runs', 'Bench runs', '<span style="color:#8b949e">unavailable (' + esc(err.message) + ')</span>'); return; }
    var runs = (data && data.runs) || [];
    alSection('bench-runs', 'Bench runs (last ' + Math.min(runs.length, 10) + ' of ' + runs.length + ')',
      alRowsTable(runs, alPickCols(runs, ['runId','startedAt','model','condition','passRate','score','tasks'])));
  });
  apiFetch('/v1/admin/bench/eval-sandbox', function(err, data){
    if(err){ alSection('eval-sandbox-runs', 'Eval sandbox (ADR-0007)', '<span style="color:#8b949e">unavailable (' + esc(err.message) + ')</span>'); return; }
    var runs = (data && data.runs) || [];
    alSection('eval-sandbox-runs', 'Eval sandbox runs (last ' + Math.min(runs.length, 10) + ' of ' + runs.length + ')',
      alRowsTable(runs, alPickCols(runs, ['scenario','passed','score','costUsd','wallMs','when','runDir'])));
  });
  apiFetch('/v1/admin/graph-runs', function(err, data){
    if(err){ alSection('graph-runs', 'Graph runs', '<span style="color:#8b949e">unavailable (' + esc(err.message) + ')</span>'); return; }
    var runs = (data && data.runs) || [];
    alSection('graph-runs', 'Graph runs (per-run spend)',
      alRowsTable(runs, alPickCols(runs, ['runId','graphName','status','budgetSpent','startedAt'])));
  });
  apiFetch('/v1/admin/graph-runs/generations', function(err, data){
    if(err){ alSection('al9-generations', 'Generations (AL9.3)', '<span style="color:#8b949e">unavailable</span>'); return; }
    var gens = (data && data.scorecard && data.scorecard.generations) || [];
    alSection('al9-generations', 'Generations (manifest lineage)',
      alRowsTable(gens, alPickCols(gens, ['manifestVersion','proposals','adopted','meanScoreDelta','flagged'])));
  });
  apiFetch('/v1/admin/graph-runs/approvals', function(err, data){
    if(err){ alSection('graph-approvals', 'Pending gate approvals', '<span style="color:#8b949e">unavailable</span>'); return; }
    var pending = (data && data.pending) || [];
    alSection('graph-approvals', 'Pending gate approvals (' + pending.length + ')',
      alRowsTable(pending, alPickCols(pending, ['runId','nodeId','requestedAt','note'])));
  });
}
var benchReloadBtn = document.getElementById('bench-reload');
if(benchReloadBtn) benchReloadBtn.onclick = loadBenchPanel;
loadBenchPanel();
`;

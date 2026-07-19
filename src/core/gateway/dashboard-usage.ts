/**
 * @file gateway/dashboard-usage.ts
 * @description BO8 / scorecard-S7 — the inline admin dashboard's Usage
 * drill-down fragment (HTML panel + client script), kept out of the already
 * large `dashboard-html.ts` template. `renderDashboardHtml()` interpolates the
 * two exported strings.
 *
 * The client script relies ONLY on helpers already defined in the parent
 * dashboard scope (`apiFetch`, `esc`, `token`), so it must be interpolated
 * inside the same `<script>` IIFE. It manages its own fetch + toggle state and
 * lives OUTSIDE `#dashboard`, so the 30 s poll re-render never tears it down.
 *
 * Backed by GET /v1/admin/system/usage (`src/core/api/admin/usage.handler.ts`),
 * which rolls up the read-only LLM ledger via `src/core/telemetry/usage-rollup.ts`.
 */

/** Usage panel markup — inserted just after the `#dashboard` container. */
export const USAGE_PANEL_HTML = `
<!-- BO8 / S7 usage drill-down. OUTSIDE #dashboard so the 30s poll re-render
     never tears down toggle state or the loaded bars. -->
<div class="section-head" style="margin-top:20px">Usage (per-day &middot; per-type)</div>
<div id="usage-panel" class="wide-panel">
  <div id="usage-controls"></div>
  <div id="usage-summary" class="panel-sub" style="margin-top:8px">Loading usage&hellip;</div>
  <div id="usage-chart" style="margin-top:12px"></div>
  <div id="usage-legend" style="margin-top:10px"></div>
  <div id="usage-drift" class="panel-sub" style="margin-top:10px"></div>
</div>`;

/**
 * Usage client script — interpolated INSIDE the dashboard `<script>` IIFE so it
 * can call the parent scope's `apiFetch`, `esc`, and read `token`. Contains no
 * backticks or `${` so it survives being nested in the parent template literal.
 */
export const USAGE_SCRIPT = `
// -------------------------------------------------------------------------
// BO8 / S7 — Usage drill-down (per-day bars + Cost/Tokens x Total/By-Type x
// 30d/90d/All). Independent of the dashboard poll: its own fetch + state so a
// toggle click never triggers a full-dashboard re-render.
// -------------------------------------------------------------------------
var usageWindow = '30d';   // 30d | 90d | all
var usageMetric = 'cost';  // cost | tokens
var usageMode   = 'total'; // total | byType
var usageDim    = 'caller';// caller | purpose | route
var lastUsage   = null;

var USAGE_COLORS = ['#3fb950','#58a6ff','#d29922','#bc8cff','#f778ba','#39c5cf','#ff7b72','#a5d6ff','#e3b341','#7ee787'];
function usageColor(i){ return USAGE_COLORS[i % USAGE_COLORS.length]; }

function usageMetricVal(o){ return usageMetric === 'cost' ? (o.cost||0) : (o.tokens||0); }
function fmtUsage(v){
  if(usageMetric === 'cost'){ return usdStr(v); }
  return fmtTok(v);
}
function usdStr(v){ return '$' + Number(v||0).toFixed(v < 1 ? 4 : 2); }
function fmtTok(n){
  n = Number(n||0);
  if(n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if(n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if(n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function usageBtn(label, active, onclick){
  var b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'margin:0 4px 4px 0;background:' + (active?'#238636':'#21262d') +
    ';color:' + (active?'#fff':'#c9d1d9') + ';border:1px solid ' + (active?'#238636':'#30363d') +
    ';border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer';
  b.onclick = onclick;
  return b;
}

function renderUsageControls(){
  var box = document.getElementById('usage-controls');
  if(!box) return;
  box.innerHTML = '';
  function group(label, opts, cur, set){
    var wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-block;margin-right:14px';
    var lb = document.createElement('span');
    lb.textContent = label + ' ';
    lb.style.cssText = 'color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-right:4px';
    wrap.appendChild(lb);
    opts.forEach(function(o){
      wrap.appendChild(usageBtn(o.label, cur === o.val, function(){ set(o.val); }));
    });
    return wrap;
  }
  box.appendChild(group('Metric', [{label:'Cost',val:'cost'},{label:'Tokens',val:'tokens'}], usageMetric,
    function(v){ usageMetric = v; renderUsage(); }));
  box.appendChild(group('View', [{label:'Total',val:'total'},{label:'By-Type',val:'byType'}], usageMode,
    function(v){ usageMode = v; renderUsage(); }));
  box.appendChild(group('Type', [{label:'Caller',val:'caller'},{label:'Purpose',val:'purpose'},{label:'Route',val:'route'}], usageDim,
    function(v){ usageDim = v; loadUsage(); }));
  box.appendChild(group('Window', [{label:'30d',val:'30d'},{label:'90d',val:'90d'},{label:'All',val:'all'}], usageWindow,
    function(v){ usageWindow = v; loadUsage(); }));
}

function loadUsage(){
  renderUsageControls();
  var sum = document.getElementById('usage-summary');
  if(sum) sum.textContent = 'Loading usage...';
  apiFetch('/v1/admin/system/usage?window=' + encodeURIComponent(usageWindow) + '&by=' + encodeURIComponent(usageDim),
    function(err, data){
      if(err || !data || !data.ok){
        if(sum) sum.textContent = 'Usage unavailable' + (err ? ' (' + err.message + ')' : '');
        return;
      }
      lastUsage = data.data;
      renderUsage();
    });
}

function renderUsage(){
  renderUsageControls();
  var u = lastUsage;
  var sum = document.getElementById('usage-summary');
  var chart = document.getElementById('usage-chart');
  var legend = document.getElementById('usage-legend');
  var drift = document.getElementById('usage-drift');
  if(!u){ return; }

  // Stable color per type key (window-wide order = cost desc).
  var colorByKey = {};
  (u.byType || []).forEach(function(tp, i){ colorByKey[tp.key] = usageColor(i); });

  var t = u.totals || {};
  if(sum){
    sum.innerHTML = '<b style="color:#e6edf3">' + esc(u.window) + '</b> \\u00b7 ' +
      esc(String(t.calls||0)) + ' calls \\u00b7 ' +
      '<span style="color:#3fb950">' + fmtTok(t.tokens||0) + ' tokens</span> \\u00b7 ' +
      '<span style="color:#d29922">' + usdStr(t.cost||0) + '</span>';
  }

  var days = u.days || [];
  var maxVal = 0;
  days.forEach(function(d){ var v = usageMetricVal(d); if(v > maxVal) maxVal = v; });
  if(maxVal <= 0) maxVal = 1;

  var rows = '';
  if(!days.length){
    rows = '<div class="panel-sub">No usage in this window.</div>';
  } else {
    days.forEach(function(d){
      var v = usageMetricVal(d);
      var pctW = Math.max(1, (v / maxVal) * 100);
      var bar;
      if(usageMode === 'byType'){
        var segs = '';
        (d.byType || []).forEach(function(c){
          var cv = usageMetricVal(c);
          if(cv <= 0) return;
          var segPct = (cv / v) * 100;
          segs += '<span title="' + esc(c.key) + ': ' + esc(fmtUsage(cv)) +
            '" style="display:inline-block;height:100%;width:' + segPct + '%;background:' +
            (colorByKey[c.key] || '#30363d') + '"></span>';
        });
        bar = '<span style="display:inline-flex;height:14px;width:' + pctW +
          '%;border-radius:3px;overflow:hidden;vertical-align:middle">' + segs + '</span>';
      } else {
        bar = '<span style="display:inline-block;height:14px;width:' + pctW + '%;background:' +
          (usageMetric === 'cost' ? '#d29922' : '#3fb950') + ';border-radius:3px;vertical-align:middle"></span>';
      }
      rows += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
        '<span style="color:#8b949e;font-size:11px;min-width:82px;font-variant-numeric:tabular-nums">' + esc(d.date) + '</span>' +
        '<span style="flex:1;min-width:120px">' + bar + '</span>' +
        '<span style="color:#e6edf3;font-size:12px;min-width:78px;text-align:right;font-variant-numeric:tabular-nums">' + esc(fmtUsage(v)) + '</span>' +
        '</div>';
    });
  }
  if(chart) chart.innerHTML = rows;

  if(legend){
    if(usageMode === 'byType' && (u.byType || []).length){
      var items = (u.byType || []).map(function(c, i){
        return '<span style="display:inline-flex;align-items:center;margin:0 12px 4px 0;font-size:12px;color:#c9d1d9">' +
          '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;background:' + usageColor(i) + '"></span>' +
          esc(c.key) + ' <span style="color:#8b949e;margin-left:5px">' + esc(fmtUsage(usageMetricVal(c))) + '</span></span>';
      }).join('');
      legend.innerHTML = items;
    } else {
      legend.innerHTML = '';
    }
  }

  if(drift){
    var dr = u.drift || {};
    var ok = !!dr.ok;
    var cd = Number(dr.costDriftPct || 0), td = Number(dr.tokenDriftPct || 0);
    drift.innerHTML = 'Ledger reconciliation: ' +
      '<span style="color:' + (ok ? '#3fb950' : '#f85149') + '">' + (ok ? 'OK within 1%' : 'DRIFT') + '</span>' +
      ' \\u00b7 cost drift ' + cd.toFixed(4) + '% \\u00b7 token drift ' + td.toFixed(4) + '%' +
      ' \\u00b7 roll-up ' + usdStr(dr.rollupCost||0) + ' vs ledger ' + usdStr(dr.directCost||0);
  }
}

if(token){
  loadUsage();
}
`;

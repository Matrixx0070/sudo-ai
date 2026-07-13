/**
 * gateway/dashboard-html.ts — Alignment dashboard HTML renderer.
 *
 * Exports a single function that returns a complete, self-contained HTML document
 * (no external CDN dependencies) for the admin alignment dashboard.
 *
 * The HTML includes inline CSS (dark theme) and inline JS that:
 *  - Reads bearer token from localStorage or URL hash #token=...
 *  - Polls /v1/admin/digest and /v1/admin/veto/threshold every 30s
 *  - Renders panels for all alignment signals
 *  - Gracefully degrades when slices are null
 */

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-Content-Type-Options" content="nosniff">
<title>SUDO-AI Alignment Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:'Courier New',Courier,monospace;font-size:14px;line-height:1.5;padding:16px}
h1{color:#f0f6fc;font-size:20px;margin-bottom:4px;letter-spacing:0.5px}
.subtitle{color:#8b949e;font-size:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:20px}
.panel{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:14px}
.panel-title{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.panel-value{color:#e6edf3;font-size:22px;font-weight:700;margin-bottom:4px;word-break:break-all}
.panel-sub{color:#8b949e;font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:0.5px}
.pill-green{background:#0d4429;color:#3fb950;border:1px solid #1a7f37}
.pill-yellow{background:#3d2900;color:#d29922;border:1px solid #9e6a03}
.pill-red{background:#3d0000;color:#f85149;border:1px solid #b62324}
.pill-grey{background:#21262d;color:#8b949e;border:1px solid #30363d}
.pill-blue{background:#0c2d6b;color:#58a6ff;border:1px solid #1f6feb}
.kv-table{width:100%;border-collapse:collapse;margin-top:6px}
.kv-table td{padding:2px 0;font-size:12px}
.kv-table td:first-child{color:#8b949e;padding-right:10px;white-space:nowrap}
.kv-table td:last-child{color:#e6edf3;text-align:right;word-break:break-all}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.bar-label{color:#8b949e;font-size:11px;width:120px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;background:#21262d;border-radius:4px;height:6px;overflow:hidden}
.bar-fill{height:100%;background:#1f6feb;border-radius:4px;transition:width 0.3s}
.bar-count{color:#8b949e;font-size:11px;width:32px;text-align:right;flex-shrink:0}
.top-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
button{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 14px;font-family:inherit;font-size:12px;cursor:pointer}
button:hover{background:#30363d;color:#e6edf3}
button:active{background:#3d444d}
.status-bar{display:flex;align-items:center;gap:12px;font-size:12px;color:#8b949e;flex-wrap:wrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fb950}
.dot-yellow{background:#d29922}
.dot-red{background:#f85149}
.dot-grey{background:#6e7681}
.error-msg{color:#f85149;font-size:12px;margin-top:4px}
.null-val{color:#6e7681;font-style:italic}
.section-head{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px;border-bottom:1px solid #21262d;padding-bottom:4px}
.wide-panel{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:14px;margin-bottom:12px}
.injection-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px;margin-top:8px}
.inj-item{background:#21262d;border-radius:4px;padding:6px 10px;display:flex;justify-content:space-between;align-items:center}
.inj-label{font-size:11px;color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px}
.inj-count{font-size:13px;color:#e6edf3;font-weight:700;flex-shrink:0}
</style>
</head>
<body>
<div class="top-bar">
  <div>
    <h1>SUDO-AI Alignment Dashboard</h1>
    <div class="subtitle">Wave 8B &mdash; admin telemetry</div>
  </div>
  <div class="actions">
    <button id="btn-refresh" onclick="refresh()">Refresh</button>
    <button id="btn-copy" onclick="copyDigest()">Copy digest JSON</button>
  </div>
</div>

<div class="status-bar">
  <span><span class="dot dot-grey" id="status-dot"></span> <span id="status-text">Loading&hellip;</span></span>
  <span id="last-updated"></span>
  <span id="poll-countdown"></span>
</div>

<div id="error-banner" style="display:none;margin-top:8px"></div>

<div id="dashboard" style="margin-top:16px">
  <!-- rendered by JS -->
</div>

<script>
(function(){
'use strict';

// -------------------------------------------------------------------------
// Token bootstrap
// -------------------------------------------------------------------------
var token = '';

function getToken(){
  // 1. URL hash #token=...
  var hash = window.location.hash;
  if(hash && hash.startsWith('#token=')){
    var t = decodeURIComponent(hash.slice(7));
    if(t){
      try{ localStorage.setItem('sudo_admin_token', t); }catch(_){}
      // redact from URL bar
      try{ history.replaceState(null,'',window.location.pathname + window.location.search); }catch(_){}
      return t;
    }
  }
  // 2. URL query ?token=...
  try{
    var params = new URLSearchParams(window.location.search);
    var qt = params.get('token');
    if(qt){
      try{ localStorage.setItem('sudo_admin_token', qt); }catch(_){}
      // strip token from URL bar so it doesn't linger in browser history
      try{ history.replaceState(null,'',window.location.pathname); }catch(_){}
      return qt;
    }
  }catch(_){}
  // 3. localStorage
  try{
    var stored = localStorage.getItem('sudo_admin_token');
    if(stored) return stored;
  }catch(_){}
  return '';
}

token = getToken();

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------
var lastDigest = null;
var lastVeto = null;
var lastCanvas = null;
var pollTimer = null;
var countdownTimer = null;
var countdownSec = 30;

// -------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------
function apiFetch(path, cb){
  var xhr = new XMLHttpRequest();
  xhr.open('GET', path, true);
  if(token) xhr.setRequestHeader('Authorization','Bearer ' + token);
  xhr.onload = function(){
    if(xhr.status === 200){
      try{
        cb(null, JSON.parse(xhr.responseText));
      }catch(e){
        cb(e, null);
      }
    } else {
      cb(new Error('HTTP ' + xhr.status), null);
    }
  };
  xhr.onerror = function(){ cb(new Error('Network error'), null); };
  xhr.send();
}

// -------------------------------------------------------------------------
// Refresh
// -------------------------------------------------------------------------
function refresh(){
  setStatus('loading','Loading\u2026','dot-grey');
  var done = 0;
  var errors = [];
  function checkDone(){
    done++;
    if(done===3){
      if(errors.length){
        setStatus('error', errors.join('; '), 'dot-red');
      } else {
        setStatus('ok','Connected','dot');
      }
      render();
    }
  }
  apiFetch('/v1/admin/digest?window=7', function(err, data){
    if(err){ errors.push('digest: ' + err.message); } else { lastDigest = data; }
    checkDone();
  });
  apiFetch('/v1/admin/veto/threshold', function(err, data){
    if(err){ errors.push('veto: ' + err.message); } else { lastVeto = data; }
    checkDone();
  });
  // A2UI canvases (Spec 2) — non-fatal: a failure must not degrade dashboard status.
  apiFetch('/v1/admin/canvas?limit=20', function(err, data){
    if(!err){ lastCanvas = data; }
    checkDone();
  });
  document.getElementById('last-updated').textContent = 'Updated: ' + new Date().toLocaleTimeString();
  resetCountdown();
}

function resetCountdown(){
  countdownSec = 30;
  if(countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(function(){
    countdownSec--;
    var el = document.getElementById('poll-countdown');
    if(el) el.textContent = 'Next refresh in ' + countdownSec + 's';
    if(countdownSec <= 0){
      clearInterval(countdownTimer);
      refresh();
    }
  }, 1000);
}

function setStatus(state, text, dotClass){
  var dot = document.getElementById('status-dot');
  var txt = document.getElementById('status-text');
  if(dot){ dot.className = 'dot ' + dotClass; }
  if(txt){ txt.textContent = text; }
}

// -------------------------------------------------------------------------
// Clipboard
// -------------------------------------------------------------------------
function copyDigest(){
  var json = JSON.stringify(lastDigest, null, 2);
  if(navigator.clipboard){
    navigator.clipboard.writeText(json).catch(function(){ fallbackCopy(json); });
  } else {
    fallbackCopy(json);
  }
}
function fallbackCopy(text){
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand('copy'); }catch(_){}
  document.body.removeChild(ta);
}

// -------------------------------------------------------------------------
// Formatting helpers
// -------------------------------------------------------------------------
function esc(s){
  if(s==null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmt(v,decimals){
  if(v==null) return '<span class="null-val">&mdash;</span>';
  if(typeof v==='number') return v.toFixed(decimals!=null?decimals:3);
  return esc(String(v));
}
function pct(v){
  if(v==null) return '<span class="null-val">&mdash;</span>';
  return (v*100).toFixed(1)+'%';
}
function pill(label, cls){
  return '<span class="pill '+esc(cls)+'">'+esc(label)+'</span>';
}
function levelPill(level){
  if(!level) return pill('UNKNOWN','pill-grey');
  var l = String(level).toUpperCase();
  if(l==='GREEN') return pill('GREEN','pill-green');
  if(l==='YELLOW') return pill('YELLOW','pill-yellow');
  if(l==='RED') return pill('RED','pill-red');
  return pill(l,'pill-grey');
}
function tierPill(tier){
  if(!tier) return pill('UNKNOWN','pill-grey');
  var t = String(tier).toUpperCase();
  if(t==='HIGH') return pill('HIGH','pill-green');
  if(t==='MEDIUM') return pill('MEDIUM','pill-yellow');
  if(t==='LOW') return pill('LOW','pill-red');
  return pill(t,'pill-grey');
}
function nullVal(){ return '<span class="null-val">&mdash;</span>'; }

function kvRow(label, value){
  return '<tr><td>'+esc(label)+'</td><td>'+value+'</td></tr>';
}

function scoreBar(label, count, max){
  var pctW = max > 0 ? Math.round((count/max)*100) : 0;
  return '<div class="bar-row">' +
    '<span class="bar-label" title="'+esc(label)+'">'+esc(label)+'</span>' +
    '<div class="bar-track"><div class="bar-fill" style="width:'+pctW+'%"></div></div>' +
    '<span class="bar-count">'+count+'</span>' +
    '</div>';
}

// -------------------------------------------------------------------------
// Panel renderers
// -------------------------------------------------------------------------
function renderAlignment(d){
  var align = d && d.alignment;
  var score = align && align.score != null ? align.score : null;
  var level = align && align.level ? align.level : null;
  var scoreDisplay = score != null ? (score*100).toFixed(1)+'%' : nullVal();
  return '<div class="panel">' +
    '<div class="panel-title">Alignment Score</div>' +
    '<div class="panel-value">'+scoreDisplay+'</div>' +
    '<div class="panel-sub">Status: '+(level ? levelPill(level) : nullVal())+'</div>' +
    (align && align.diagnosis ? '<div class="panel-sub" style="margin-top:6px;font-size:11px;color:#6e7681;word-break:break-word">'+esc(align.diagnosis)+'</div>' : '') +
  '</div>';
}

function renderTrust(d){
  var trust = d && d.trust;
  var tier = trust && trust.tier ? trust.tier : null;
  var score = trust && trust.score != null ? trust.score : null;
  return '<div class="panel">' +
    '<div class="panel-title">Trust Tier</div>' +
    '<div class="panel-value">'+(tier ? tierPill(tier) : nullVal())+'</div>' +
    '<div class="panel-sub">Score: '+(score != null ? fmt(score) : nullVal())+'</div>' +
    (trust && trust.windowSizeDays ? '<div class="panel-sub">Window: '+esc(trust.windowSizeDays)+'d</div>' : '') +
  '</div>';
}

function renderBrier(d){
  var cal = d && d.calibration;
  var brier = cal && cal.brierScore != null ? cal.brierScore : null;
  var samples = cal && cal.totalSamples != null ? cal.totalSamples : null;
  var brierpct = brier != null ? (brier*100).toFixed(1)+'%' : null;
  // lower brier is better
  var briercls = brier == null ? '' : brier < 0.15 ? 'pill-green' : brier < 0.25 ? 'pill-yellow' : 'pill-red';
  return '<div class="panel">' +
    '<div class="panel-title">Brier Score (Calibration)</div>' +
    '<div class="panel-value">'+(brierpct != null ? '<span class="pill '+briercls+'">'+esc(brierpct)+'</span>' : nullVal())+'</div>' +
    '<div class="panel-sub">Samples: '+(samples != null ? samples : nullVal())+'</div>' +
    '<div class="panel-sub" style="font-size:11px;color:#6e7681;margin-top:4px">Lower is better</div>' +
  '</div>';
}

function renderCommitments(d){
  var comm = d && d.commitments;
  var expiring = comm && comm.expiring != null ? comm.expiring : null;
  var expired = comm && comm.expired != null ? comm.expired : null;
  return '<div class="panel">' +
    '<div class="panel-title">Commitments</div>' +
    '<div class="panel-value">'+(expiring != null ? expiring : nullVal())+'</div>' +
    '<div class="panel-sub">Expiring soon</div>' +
    '<table class="kv-table" style="margin-top:8px">' +
    kvRow('Expired', expired != null ? String(expired) : nullVal()) +
    '</table>' +
  '</div>';
}

function renderPatterns(d){
  var pat = d && d.patterns;
  var recurring = pat && pat.recurringCount != null ? pat.recurringCount : null;
  var total = pat && pat.totalMistakes != null ? pat.totalMistakes : null;
  return '<div class="panel">' +
    '<div class="panel-title">Mistake Patterns</div>' +
    '<div class="panel-value">'+(recurring != null ? recurring : nullVal())+'</div>' +
    '<div class="panel-sub">Recurring patterns</div>' +
    '<table class="kv-table" style="margin-top:8px">' +
    kvRow('Total mistakes', total != null ? String(total) : nullVal()) +
    '</table>' +
  '</div>';
}

function renderVeto(vetoData){
  var vd = vetoData && vetoData.data ? vetoData.data : null;
  var threshold = vd && vd.effectiveThreshold != null ? vd.effectiveThreshold : null;
  var autoTune = vd && vd.autoTuneEnabled != null ? vd.autoTuneEnabled : null;
  return '<div class="panel">' +
    '<div class="panel-title">Veto Threshold</div>' +
    '<div class="panel-value">'+(threshold != null ? fmt(threshold) : nullVal())+'</div>' +
    '<div class="panel-sub">Auto-tune: '+(autoTune != null ? (autoTune ? pill('ENABLED','pill-green') : pill('DISABLED','pill-grey')) : nullVal())+'</div>' +
    (vd && vd.computedAt ? '<div class="panel-sub" style="font-size:11px;color:#6e7681;margin-top:4px">Computed: '+esc(new Date(vd.computedAt).toLocaleString())+'</div>' : '') +
  '</div>';
}

function renderReanchor(d){
  var ra = d && d.reanchor;
  var total = ra && ra.total != null ? ra.total : null;
  var byTrigger = ra && ra.byTrigger ? ra.byTrigger : null;
  var triggers = byTrigger ? Object.keys(byTrigger) : [];
  var maxCount = triggers.length > 0 ? Math.max.apply(null, triggers.map(function(k){ return byTrigger[k]; })) : 0;
  return '<div class="wide-panel">' +
    '<div class="panel-title">Re-Anchor Events by Trigger</div>' +
    '<div style="margin-bottom:8px">Total: '+(total != null ? '<strong>'+total+'</strong>' : nullVal())+'</div>' +
    (triggers.length > 0 ? triggers.map(function(k){ return scoreBar(k, byTrigger[k], maxCount||1); }).join('') : '<div class="null-val">No trigger data</div>') +
  '</div>';
}

function renderDiagnostics(d){
  var diag = d && d.diagnostics;
  var total = diag && diag.totalEventsScanned != null ? diag.totalEventsScanned : null;
  var corrCount = diag && diag.correlationCount != null ? diag.correlationCount : null;
  return '<div class="panel">' +
    '<div class="panel-title">Cross-Signal Diagnostics</div>' +
    '<div class="panel-value">'+(total != null ? total : nullVal())+'</div>' +
    '<div class="panel-sub">Events scanned</div>' +
    '<table class="kv-table" style="margin-top:8px">' +
    kvRow('Correlations', corrCount != null ? String(corrCount) : nullVal()) +
    '</table>' +
  '</div>';
}

function renderInjection(d){
  var inj = d && d.injection;
  if(!inj){
    return '<div class="wide-panel">' +
      '<div class="panel-title">Injection Detections</div>' +
      '<div class="null-val">No data</div>' +
    '</div>';
  }
  var byKind = inj.byKind || {};
  var kinds = Object.keys(byKind);
  var maxCount = kinds.length > 0 ? Math.max.apply(null, kinds.map(function(k){ return byKind[k]; })) : 0;
  return '<div class="wide-panel">' +
    '<div class="panel-title">Injection Detections &mdash; Total: <strong>'+(inj.total != null ? inj.total : nullVal())+'</strong></div>' +
    '<div class="injection-grid" style="margin-top:8px">' +
    (kinds.length > 0 ? kinds.map(function(k){
      return '<div class="inj-item"><span class="inj-label" title="'+esc(k)+'">'+esc(k)+'</span><span class="inj-count">'+byKind[k]+'</span></div>';
    }).join('') : '<div class="null-val">No injection records</div>') +
    '</div>' +
  '</div>';
}

// -------------------------------------------------------------------------
// A2UI canvases (Spec 2) — read-only monitor of the interactive UI the agent
// is rendering to sessions. Every dynamic value goes through esc() before it
// touches innerHTML (canvas titles/labels are agent/user-authored).
// -------------------------------------------------------------------------
function summariseComp(c){
  var t = (c && c.type) ? String(c.type) : '?';
  if(t==='text') return 'text: ' + esc(c.text);
  if(t==='metric') return 'metric: ' + esc(c.label) + ' = ' + esc(c.value);
  if(t==='chart'){
    var s = (c.series && c.series.length) ? c.series : [];
    var pts = s.map(function(p){ return esc(p.label) + '=' + esc(p.value); }).join(', ');
    return 'chart' + (c.title ? ' "' + esc(c.title) + '"' : '') + ': ' + pts;
  }
  if(t==='table'){
    var rows = (c.rows && c.rows.length) ? c.rows.length : 0;
    var cols = (c.columns && c.columns.length) ? c.columns.length : 0;
    return 'table: ' + cols + ' cols × ' + rows + ' rows';
  }
  if(t==='form'){
    var f = (c.fields && c.fields.length) ? c.fields.length : 0;
    return 'form' + (c.title ? ' "' + esc(c.title) + '"' : '') + ': ' + f + ' field(s) → ' + esc(c.submitActionId);
  }
  if(t==='button') return 'button: "' + esc(c.label) + '" → ' + esc(c.actionId);
  if(t==='progress') return 'progress: ' + esc(c.label) + ' ' + esc(c.value) + '%';
  if(t==='list'){ var n = (c.items && c.items.length) ? c.items.length : 0; return 'list: ' + n + ' item(s)'; }
  return esc(t);
}
function renderCanvas(){
  var states = (lastCanvas && lastCanvas.data) ? lastCanvas.data : [];
  var body;
  if(!states.length){
    body = '<div class="null-val">No canvases rendered yet.</div>';
  } else {
    body = states.map(function(s){
      var comps = (s.components || []).map(function(c){
        return '<li>' + summariseComp(c) + '</li>';
      }).join('');
      return '<div style="border:1px solid #30363d;border-radius:6px;padding:10px;margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;gap:8px">' +
          '<span style="color:#e6edf3">' + (s.title ? esc(s.title) : '<span class="null-val">(untitled)</span>') + '</span>' +
          '<span class="panel-sub">' + (s.componentCount != null ? s.componentCount : 0) + ' comp · ' + esc(s.updatedAt) + '</span>' +
        '</div>' +
        '<div class="panel-sub" style="margin:4px 0 6px">session ' + esc(s.sessionId) + '</div>' +
        '<ul style="padding-left:16px;color:#c9d1d9">' + comps + '</ul>' +
      '</div>';
    }).join('');
  }
  return '<div class="wide-panel"><div class="panel-title">A2UI Canvases (live)</div>' + body + '</div>';
}

// -------------------------------------------------------------------------
// Main render
// -------------------------------------------------------------------------
function render(){
  var d = lastDigest && lastDigest.data ? lastDigest.data : null;
  var html = '';

  html += '<div class="grid">';
  html += renderAlignment(d);
  html += renderTrust(d);
  html += renderBrier(d);
  html += renderCommitments(d);
  html += renderPatterns(d);
  html += renderDiagnostics(d);
  html += renderVeto(lastVeto);
  html += '</div>';

  html += '<div class="section-head">Injection &amp; Re-Anchor Analysis</div>';
  html += renderInjection(d);
  html += renderReanchor(d);

  if(d && d.resolutions){
    var res = d.resolutions;
    html += '<div class="section-head">Commitment Resolutions</div>';
    html += '<div class="panel" style="max-width:320px">' +
      '<div class="panel-title">Honor Rate</div>' +
      '<div class="panel-value">'+pct(res.honorRate)+'</div>' +
      '<table class="kv-table" style="margin-top:8px">' +
      kvRow('Total', res.total != null ? String(res.total) : nullVal()) +
      kvRow('Honored', res.honored != null ? String(res.honored) : nullVal()) +
      kvRow('Abandoned', res.abandoned != null ? String(res.abandoned) : nullVal()) +
      '</table>' +
    '</div>';
  }

  html += '<div class="section-head">Generative UI (A2UI)</div>';
  html += renderCanvas();

  document.getElementById('dashboard').innerHTML = html;
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------
if(!token){
  document.getElementById('dashboard').innerHTML =
    '<div class="panel" style="border-color:#f85149">' +
    '<div class="panel-title" style="color:#f85149">No admin token</div>' +
    '<div class="panel-sub" style="margin-top:8px">Supply token via URL hash: <code>#token=YOUR_TOKEN</code><br>' +
    'It will be saved to localStorage for future loads.</div>' +
    '</div>';
  setStatus('error','No token configured','dot-red');
} else {
  refresh();
  if(pollTimer) clearInterval(pollTimer);
}

})();
</script>
</body>
</html>`;
}

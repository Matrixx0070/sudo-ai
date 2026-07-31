/**
 * @file dashboard-html.ts
 * @description Self-contained webhook dashboard (GET /v1/events/dashboard).
 * Vanilla JS, no build step, INLINE by design (the SPA path is dead — see
 * project memory on A2UI). Token is entered once, kept in localStorage, and
 * sent as a Bearer header on every API call.
 */

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sudo AI — Webhooks</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --dim:#8b949e; --acc:#2f81f7; --ok:#3fb950; --bad:#f85149; --warn:#d29922; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  header { padding:14px 24px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:16px; }
  h1 { font-size:16px; margin:0; } h1 small { color:var(--dim); font-weight:normal; }
  main { max-width:1100px; margin:0 auto; padding:24px; display:grid; gap:20px; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:16px; }
  .panel h2 { margin:0 0 12px; font-size:14px; }
  input, select, button, textarea { background:#0d1117; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font:inherit; }
  button { cursor:pointer; } button.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
  button.danger { color:var(--bad); } button:disabled { opacity:.5; cursor:default; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--dim); font-weight:600; }
  .pill { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; border:1px solid var(--border); }
  .pill.succeeded { color:var(--ok); border-color:var(--ok); } .pill.dead { color:var(--bad); border-color:var(--bad); }
  .pill.pending, .pill.delivering { color:var(--warn); border-color:var(--warn); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .events-pick { max-height:180px; overflow:auto; border:1px solid var(--border); border-radius:6px; padding:8px; column-count:2; }
  .events-pick label { display:block; color:var(--dim); font-size:12px; }
  code { background:#0d1117; border:1px solid var(--border); border-radius:4px; padding:1px 5px; font-size:12px; word-break:break-all; }
  .muted { color:var(--dim); } .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  #secretbox { display:none; border-color:var(--ok); }
  dialog { background:var(--panel); color:var(--fg); border:1px solid var(--border); border-radius:8px; max-width:640px; }
</style>
</head>
<body>
<header>
  <h1>Sudo AI <small>· Webhooks &amp; Events</small></h1>
  <span id="stats" class="muted"></span>
  <span style="flex:1"></span>
  <input id="token" type="password" placeholder="gateway token" size="24">
  <button onclick="saveToken()">Connect</button>
</header>
<main>
  <div class="panel" id="secretbox">
    <h2>Signing secret — copy it now, it is shown only once</h2>
    <code id="secretval"></code>
  </div>

  <div class="panel">
    <h2>Create endpoint</h2>
    <div class="grid2">
      <input id="c_name" placeholder="Name">
      <input id="c_url" placeholder="https://example.com/hooks/sudo">
      <input id="c_desc" placeholder="Description (optional)" style="grid-column:1/3">
      <div style="grid-column:1/3">
        <div class="row" style="margin-bottom:6px">
          <label><input type="checkbox" id="c_all" checked onchange="toggleAll()"> all events (*)</label>
          <span class="muted">or pick:</span>
        </div>
        <div class="events-pick" id="c_events"></div>
      </div>
      <div class="row"><span class="muted">max retries</span><input id="c_retry" type="number" min="0" max="10" value="5" style="width:70px"></div>
      <div class="row" style="justify-content:flex-end"><button class="primary" onclick="createEp()">Create endpoint</button></div>
    </div>
  </div>

  <div class="panel">
    <h2>Endpoints</h2>
    <table><thead><tr><th>Name / URL</th><th>Events</th><th>Enabled</th><th>Secret</th><th>Actions</th></tr></thead>
    <tbody id="eps"></tbody></table>
  </div>

  <div class="panel">
    <h2 class="row">Deliveries <select id="d_status" onchange="loadDeliveries()">
      <option value="">all</option><option>pending</option><option>delivering</option><option>succeeded</option><option>dead</option>
    </select> <select id="d_ep" onchange="loadDeliveries()"><option value="">all endpoints</option></select>
    <button onclick="loadDeliveries()">Refresh</button></h2>
    <table><thead><tr><th>Delivery</th><th>Event</th><th>Status</th><th>Attempt</th><th>Last</th><th></th></tr></thead>
    <tbody id="dels"></tbody></table>
  </div>

  <div class="panel">
    <h2 class="row">Recent events <button onclick="loadEvents()">Refresh</button></h2>
    <table><thead><tr><th>Id</th><th>Type</th><th>Created</th><th>Channels</th></tr></thead><tbody id="evts"></tbody></table>
  </div>
</main>
<dialog id="detail"><pre id="detailpre" style="white-space:pre-wrap"></pre><button onclick="detail.close()">Close</button></dialog>
<script>
const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem('sudo_gw_token') || '';
$('token').value = TOKEN;
function saveToken(){ TOKEN = $('token').value.trim(); localStorage.setItem('sudo_gw_token', TOKEN); refresh(); }
async function api(path, opts){
  const r = await fetch(path, { ...(opts||{}), headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+TOKEN, ...(opts&&opts.headers||{}) } });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error((j.error&&j.error.message)||('HTTP '+r.status));
  return j;
}
function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

let TYPES = [];
async function loadTypes(){
  const j = await api('/v1/events/types');
  TYPES = j.webhook_eligible;
  $('c_events').innerHTML = TYPES.map(t=>'<label><input type="checkbox" class="evt" value="'+t+'" disabled> '+t+'</label>').join('');
}
function toggleAll(){ document.querySelectorAll('.evt').forEach(c=>{ c.disabled = $('c_all').checked; }); }

async function createEp(){
  const eventTypes = $('c_all').checked ? ['*'] : [...document.querySelectorAll('.evt:checked')].map(c=>c.value);
  try {
    const j = await api('/v1/webhook-endpoints', { method:'POST', body: JSON.stringify({
      name: $('c_name').value, url: $('c_url').value, description: $('c_desc').value,
      event_types: eventTypes, retry_max: Number($('c_retry').value) }) });
    showSecret(j.endpoint.secret);
    $('c_name').value=$('c_url').value=$('c_desc').value='';
    refresh();
  } catch(e){ alert(e.message); }
}
function showSecret(s){ $('secretval').textContent = s; $('secretbox').style.display='block'; window.scrollTo(0,0); }

async function loadEps(){
  const j = await api('/v1/webhook-endpoints');
  $('d_ep').innerHTML = '<option value="">all endpoints</option>' + j.endpoints.map(e=>'<option value="'+e.id+'">'+esc(e.name)+'</option>').join('');
  $('eps').innerHTML = j.endpoints.map(e=>'<tr>'+
    '<td><b>'+esc(e.name)+'</b><br><span class="muted">'+esc(e.url)+'</span></td>'+
    '<td>'+e.event_types.map(t=>'<code>'+esc(t)+'</code>').join(' ')+'</td>'+
    '<td>'+(e.enabled?'✅':'⏸️')+'</td>'+
    '<td><code>'+esc(e.secret)+'</code></td>'+
    '<td class="row">'+
      '<button onclick="testEp(\\''+e.id+'\\')">Test</button>'+
      '<button onclick="toggleEp(\\''+e.id+'\\','+(!e.enabled)+')">'+(e.enabled?'Disable':'Enable')+'</button>'+
      '<button onclick="rotateEp(\\''+e.id+'\\')">Rotate secret</button>'+
      '<button class="danger" onclick="delEp(\\''+e.id+'\\')">Delete</button>'+
    '</td></tr>').join('') || '<tr><td colspan="5" class="muted">No endpoints yet</td></tr>';
}
async function testEp(id){
  try { const j = await api('/v1/webhook-endpoints/'+id+'/test', {method:'POST'});
    alert('Test delivery: '+(j.delivery ? j.delivery.status+' (HTTP '+(j.delivery.lastStatusCode||'—')+')' : 'deduped'));
    loadDeliveries();
  } catch(e){ alert(e.message); }
}
async function toggleEp(id, enabled){ try { await api('/v1/webhook-endpoints/'+id, {method:'PATCH', body: JSON.stringify({enabled})}); loadEps(); } catch(e){ alert(e.message); } }
async function rotateEp(id){
  if (!confirm('Rotate signing secret? The old one keeps verifying for 24h.')) return;
  try { const j = await api('/v1/webhook-endpoints/'+id+'/rotate-secret', {method:'POST'}); showSecret(j.endpoint.secret); loadEps(); } catch(e){ alert(e.message); }
}
async function delEp(id){
  if (!confirm('Delete this endpoint and its delivery history?')) return;
  try { await api('/v1/webhook-endpoints/'+id, {method:'DELETE'}); refresh(); } catch(e){ alert(e.message); }
}

async function loadDeliveries(){
  const ep = $('d_ep').value, st = $('d_status').value;
  const path = ep ? '/v1/webhook-endpoints/'+ep+'/deliveries?limit=100'+(st?'&status='+st:'') : null;
  let rows = [];
  if (path) rows = (await api(path)).deliveries;
  else {
    const eps = (await api('/v1/webhook-endpoints')).endpoints;
    for (const e of eps) rows.push(...(await api('/v1/webhook-endpoints/'+e.id+'/deliveries?limit=30'+(st?'&status='+st:''))).deliveries);
    rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  $('dels').innerHTML = rows.map(d=>'<tr>'+
    '<td><a href="#" onclick="showDelivery(\\''+d.id+'\\');return false"><code>'+d.id.slice(0,18)+'…</code></a></td>'+
    '<td><code>'+d.eventId.slice(0,16)+'…</code></td>'+
    '<td><span class="pill '+d.status+'">'+d.status+'</span></td>'+
    '<td>'+d.attempt+'/'+d.maxAttempts+'</td>'+
    '<td class="muted">'+(d.lastStatusCode||'')+' '+esc(d.lastError||'')+'</td>'+
    '<td>'+(d.status==='dead'||d.status==='succeeded'?'<button onclick="replay(\\''+d.id+'\\')">Replay</button>':'')+'</td>'+
    '</tr>').join('') || '<tr><td colspan="6" class="muted">No deliveries</td></tr>';
}
async function showDelivery(id){
  const j = await api('/v1/events/deliveries/'+id);
  $('detailpre').textContent = JSON.stringify(j, null, 2);
  $('detail').showModal();
}
async function replay(id){ try { await api('/v1/events/deliveries/'+id+'/replay', {method:'POST'}); setTimeout(loadDeliveries, 800); } catch(e){ alert(e.message); } }

async function loadEvents(){
  const j = await api('/v1/events?limit=30');
  $('evts').innerHTML = j.events.map(e=>'<tr><td><code>'+e.id+'</code></td><td>'+esc(e.type)+'</td>'+
    '<td class="muted">'+e.createdAt+'</td><td>'+e.channels.map(c=>'<code>'+esc(c)+'</code>').join(' ')+'</td></tr>').join('')
    || '<tr><td colspan="4" class="muted">No events yet</td></tr>';
}
async function loadStats(){
  const s = await api('/v1/events/stats');
  const d = s.deliveries;
  $('stats').textContent = s.events+' events · '+s.endpoints+' endpoints · '+(d.succeeded||0)+' delivered · '+(d.dead||0)+' dead';
}
async function refresh(){
  if (!TOKEN) return;
  try { await loadTypes(); await Promise.all([loadEps(), loadDeliveries(), loadEvents(), loadStats()]); }
  catch(e){ $('stats').textContent = e.message; }
}
refresh();
</script>
</body>
</html>`;
}

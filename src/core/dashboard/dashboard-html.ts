/**
 * dashboard-html.ts
 *
 * Dashboard HTML UI template.
 */

/** Dashboard HTML UI with embedded CSS and JavaScript. */
export const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SUDO-AI Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f1a; color: #e0e0e0; padding: 20px; }
    h1 { color: #00d9ff; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .card { background: #1a1a2e; border-radius: 8px; padding: 20px; border: 1px solid #2a2a4a; }
    .card h2 { color: #00d9ff; font-size: 14px; margin-bottom: 15px; text-transform: uppercase; }
    .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #2a2a4a; }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #888; }
    .stat-value { color: #00ff88; font-weight: bold; }
    .status-ok { color: #00ff88; }
    .status-warn { color: #ffaa00; }
    .status-error { color: #ff4444; }
    .health-item { padding: 8px 0; border-bottom: 1px solid #2a2a4a; }
    .health-item:last-child { border-bottom: none; }
    .agent-row { padding: 8px 0; border-bottom: 1px solid #2a2a4a; font-size: 13px; }
    .agent-row:last-child { border-bottom: none; }
    .agent-id { color: #00d9ff; font-family: monospace; font-size: 11px; }
    .agent-task { color: #e0e0e0; margin: 4px 0; word-break: break-word; }
    .agent-meta { color: #888; font-size: 11px; display: flex; gap: 12px; }
    .agent-idle-flag { color: #ffaa00; font-weight: bold; }
    .fleet-summary { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #2a2a4a; margin-bottom: 8px; }
    .alignment-bar { height: 8px; background: #2a2a4a; border-radius: 4px; overflow: hidden; margin-top: 10px; }
    .alignment-fill { height: 100%; background: linear-gradient(90deg, #00d9ff, #00ff88); transition: width 0.3s; }
    #last-update { color: #666; font-size: 12px; margin-top: 20px; }
    .error { color: #ff4444; }
  </style>
</head>
<body>
  <h1>SUDO-AI Dashboard</h1>
  <div id="error" class="error" style="display:none; margin-bottom: 20px;"></div>
  <div class="grid">
    <div class="card">
      <h2>System Stats</h2>
      <div class="stat"><span class="stat-label">Uptime</span><span class="stat-value" id="uptime">-</span></div>
      <div class="stat"><span class="stat-label">Total Requests</span><span class="stat-value" id="totalRequests">-</span></div>
      <div class="stat"><span class="stat-label">Active Sessions</span><span class="stat-value" id="activeSessions">-</span></div>
      <div class="stat"><span class="stat-label">Memory RSS</span><span class="stat-value" id="memoryRss">-</span></div>
      <div class="stat"><span class="stat-label">CPU Usage</span><span class="stat-value" id="cpuUsage">-</span></div>
    </div>
    <div class="card">
      <h2>Health Status</h2>
      <div id="health-status" style="margin-bottom: 10px; font-size: 18px;"></div>
      <div id="health-checks"></div>
    </div>
    <div class="card">
      <h2>Alignment Score</h2>
      <div class="stat"><span class="stat-label">Overall Score</span><span class="stat-value" id="alignment-score">-</span></div>
      <div class="alignment-bar"><div class="alignment-fill" id="alignment-bar" style="width: 0%;"></div></div>
      <div id="alignment-signals" style="margin-top: 15px;"></div>
    </div>
    <div class="card">
      <h2>Recent Activity</h2>
      <div id="activity-list"></div>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>Claude OAuth (PKCE)</h2>
      <div id="coauth-status" style="margin-bottom: 12px;"><span class="stat-label">Loading...</span></div>
      <div id="coauth-actions" style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button id="coauth-login-btn" style="background: #00d9ff; color: #0f0f1a; border: 0; padding: 8px 14px; border-radius: 4px; font-weight: bold; cursor: pointer;">Connect Claude (OAuth)</button>
        <button id="coauth-refresh-btn" style="background: #2a2a4a; color: #e0e0e0; border: 0; padding: 8px 14px; border-radius: 4px; cursor: pointer; display: none;">Refresh now</button>
        <button id="coauth-disconnect-btn" style="background: #5a1a2a; color: #ffaaaa; border: 0; padding: 8px 14px; border-radius: 4px; cursor: pointer; display: none;">Disconnect</button>
      </div>
      <div id="coauth-login-panel" style="margin-top: 14px; display: none;">
        <div style="margin-bottom: 8px; color: #888; font-size: 13px;">
          1. Open this URL in a new tab, approve, then copy the code shown on the callback page:
        </div>
        <div style="margin-bottom: 10px;">
          <a id="coauth-authorize-link" target="_blank" rel="noopener noreferrer" style="color: #00d9ff; word-break: break-all;"></a>
        </div>
        <div style="display: flex; gap: 8px;">
          <input id="coauth-code-input" type="text" placeholder="Paste authorization code" style="flex:1; padding: 8px; background:#0f0f1a; color:#e0e0e0; border:1px solid #2a2a4a; border-radius: 4px;" />
          <button id="coauth-complete-btn" style="background: #00ff88; color: #0f0f1a; border: 0; padding: 8px 14px; border-radius: 4px; font-weight: bold; cursor: pointer;">Complete</button>
        </div>
        <div id="coauth-login-error" class="error" style="margin-top: 8px; display: none;"></div>
      </div>
      <div id="coauth-models-panel" style="margin-top: 18px; display: none; border-top: 1px solid #2a2a4a; padding-top: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px;">
          <h3 style="color: #00d9ff; font-size: 13px; text-transform: uppercase; margin: 0;">Default Model</h3>
          <button id="coauth-models-refresh-btn" style="background: #2a2a4a; color: #e0e0e0; border: 0; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;">Refresh list</button>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <select id="coauth-models-select" style="flex:1; padding: 8px; background:#0f0f1a; color:#e0e0e0; border:1px solid #2a2a4a; border-radius: 4px;"></select>
          <button id="coauth-models-save-btn" style="background: #00d9ff; color: #0f0f1a; border: 0; padding: 8px 14px; border-radius: 4px; font-weight: bold; cursor: pointer;">Save</button>
        </div>
        <div id="coauth-models-hint" style="margin-top: 8px; color: #888; font-size: 12px;">
          Use this model in sudo-ai's brain config as <code id="coauth-model-string" style="color:#00ff88;">claude-oauth/&lt;id&gt;</code>
        </div>
        <div id="coauth-models-error" class="error" style="margin-top: 8px; display: none;"></div>
      </div>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>Grok Model Picker</h2>
      <div id="grok-status" style="margin-bottom: 12px;"><span class="stat-label">Loading...</span></div>
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 10px;">
        <label for="grok-method-select" style="color:#888; font-size:12px;">Provider</label>
        <select id="grok-method-select" style="padding: 8px; background:#0f0f1a; color:#e0e0e0; border:1px solid #2a2a4a; border-radius: 4px;">
          <option value="oauth">xai-oauth — Sign in with Grok (subscription-covered)</option>
          <option value="apikey">xai — Grok API Key (pay-per-token)</option>
        </select>
        <button id="grok-models-refresh-btn" style="background: #2a2a4a; color: #e0e0e0; border: 0; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">Refresh list</button>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <select id="grok-models-select" style="flex:1; padding: 8px; background:#0f0f1a; color:#e0e0e0; border:1px solid #2a2a4a; border-radius: 4px;"></select>
        <button id="grok-models-save-btn" style="background: #00d9ff; color: #0f0f1a; border: 0; padding: 8px 14px; border-radius: 4px; font-weight: bold; cursor: pointer;">Set default</button>
      </div>
      <div id="grok-models-hint" style="margin-top: 8px; color: #888; font-size: 12px;">
        Brain model string: <code id="grok-model-string" style="color:#00ff88;">xai-oauth/&lt;id&gt;</code>
      </div>
      <div id="grok-models-error" class="error" style="margin-top: 8px; display: none;"></div>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>FleetView — Live Agents</h2>
      <div id="fleet-summary" class="fleet-summary">
        <span class="stat-label">Slots</span><span class="stat-value" id="fleet-slots">- / -</span>
        <span class="stat-label">Queued</span><span class="stat-value" id="fleet-queued">-</span>
        <span class="stat-label">Idle</span><span class="stat-value" id="fleet-idle">-</span>
      </div>
      <div id="fleet-agents"></div>
    </div>
  </div>
  <div id="last-update">Last update: -</div>
  <script>
    const REFRESH_MS = 30000;
    const TOKEN_KEY = 'sudo_dashboard_token';

    function getToken() {
      return localStorage.getItem(TOKEN_KEY) || prompt('Enter dashboard auth token:') || '';
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      return h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
    }

    async function fetchJson(url) {
      const token = getToken();
      const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        throw new Error('Authentication failed');
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function updateStats() {
      try {
        const stats = await fetchJson('/api/stats');
        document.getElementById('uptime').textContent = formatUptime(stats.uptime);
        document.getElementById('totalRequests').textContent = stats.totalRequests.toLocaleString();
        document.getElementById('activeSessions').textContent = stats.activeSessions;
        document.getElementById('memoryRss').textContent = formatBytes(stats.memoryUsage.rss);
        document.getElementById('cpuUsage').textContent = stats.cpuUsage + '%';
        document.getElementById('error').style.display = 'none';
      } catch (e) {
        document.getElementById('error').textContent = 'Stats error: ' + e.message;
        document.getElementById('error').style.display = 'block';
      }
    }

    async function updateHealth() {
      try {
        const health = await fetchJson('/api/health');
        const statusEl = document.getElementById('health-status');
        statusEl.textContent = health.status.toUpperCase();
        statusEl.className = health.status === 'healthy' ? 'status-ok' : health.status === 'degraded' ? 'status-warn' : 'status-error';
        const checksEl = document.getElementById('health-checks');
        // c.message is a free-text string from the dashboard server; escape it
        // for consistency with updateFleet() — getHealth() does not currently
        // surface user-supplied strings, but a future signal that incorporates
        // upstream data shouldn't bypass HTML escaping by accident.
        checksEl.innerHTML = health.checks.map(c =>
          '<div class="health-item"><span class="' + (c.status === 'ok' ? 'status-ok' : c.status === 'warn' ? 'status-warn' : 'status-error') + '">' + escapeHtml(c.name) + ': ' + c.status.toUpperCase() + '</span>' + (c.message ? ' - ' + escapeHtml(c.message) : '') + '</div>'
        ).join('');
      } catch (e) {
        document.getElementById('health-checks').innerHTML = '<div class="error">Health check failed</div>';
      }
    }

    async function updateAlignment() {
      try {
        const alignment = await fetchJson('/api/alignment');
        document.getElementById('alignment-score').textContent = alignment.score.toFixed(3);
        document.getElementById('alignment-bar').style.width = (alignment.score * 100) + '%';
        const signalsEl = document.getElementById('alignment-signals');
        signalsEl.innerHTML = Object.entries(alignment.signals || {}).map(([k, v]) =>
          '<div class="stat"><span class="stat-label">' + k + '</span><span class="stat-value">' + (typeof v === 'number' ? v.toFixed(3) : v) + '</span></div>'
        ).join('');
      } catch (e) {
        document.getElementById('alignment-signals').innerHTML = '<div class="error">Alignment data unavailable</div>';
      }
    }

    async function updateActivity() {
      try {
        const activity = await fetchJson('/api/activity?limit=10');
        const activityEl = document.getElementById('activity-list');
        if (!activity || activity.length === 0) {
          activityEl.innerHTML = '<div style="color: #666;">No recent activity</div>';
        } else {
          activityEl.innerHTML = activity.map(a =>
            '<div class="health-item"><span style="color: #00d9ff; font-size: 12px;">' + new Date(a.timestamp).toLocaleTimeString() + '</span> - ' + a.summary + '</div>'
          ).join('');
        }
      } catch (e) {
        // Activity errors are non-critical
      }
    }

    function formatElapsed(ms) {
      if (ms < 1000) return ms + 'ms';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      const rs = s % 60;
      return m + 'm' + rs.toString().padStart(2, '0') + 's';
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function updateFleet() {
      try {
        const fleet = await fetchJson('/api/agents/live');
        const idleCount = (fleet.spawned || []).filter(a => a.idle).length;
        document.getElementById('fleet-slots').textContent = fleet.slotsUsed + ' / ' + fleet.slotsMax;
        document.getElementById('fleet-queued').textContent = fleet.queueWaiting;
        document.getElementById('fleet-idle').textContent = idleCount;
        const agentsEl = document.getElementById('fleet-agents');
        if (!fleet.spawned || fleet.spawned.length === 0) {
          agentsEl.innerHTML = '<div style="color: #666; padding: 8px 0;">No agents spawned</div>';
        } else {
          agentsEl.innerHTML = fleet.spawned.map(a =>
            '<div class="agent-row">' +
              '<span class="agent-id">' + escapeHtml(a.id) + '</span>' +
              (a.idle ? ' <span class="agent-idle-flag">[IDLE]</span>' : '') +
              '<div class="agent-task">' + escapeHtml(a.task) + '</div>' +
              '<div class="agent-meta">' +
                '<span>elapsed ' + formatElapsed(a.elapsedMs) + '</span>' +
                '<span>heartbeat ' + formatElapsed(a.sinceHeartbeatMs) + ' ago</span>' +
              '</div>' +
            '</div>'
          ).join('');
        }
      } catch (e) {
        document.getElementById('fleet-agents').innerHTML = '<div class="error">Fleet data unavailable</div>';
      }
    }

    function updateTimestamp() {
      document.getElementById('last-update').textContent = 'Last update: ' + new Date().toLocaleTimeString();
    }

    // -----------------------------------------------------------------------
    // Claude OAuth (PKCE) panel
    // -----------------------------------------------------------------------

    async function postJson(url, body) {
      const token = getToken();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      return data.data;
    }

    function renderCoauthStatus(s) {
      const statusEl = document.getElementById('coauth-status');
      const refreshBtn = document.getElementById('coauth-refresh-btn');
      const disconnectBtn = document.getElementById('coauth-disconnect-btn');
      const loginBtn = document.getElementById('coauth-login-btn');
      const modelsPanel = document.getElementById('coauth-models-panel');
      if (s && s.connected) {
        const expMin = s.expiresInSec != null ? Math.round(s.expiresInSec / 60) : null;
        const expTxt = expMin == null ? 'n/a' : (expMin > 60 ? Math.floor(expMin / 60) + 'h ' + (expMin % 60) + 'm' : expMin + 'm');
        statusEl.innerHTML =
          '<span class="status-ok">CONNECTED</span> &middot; ' +
          'expires in <span class="stat-value">' + escapeHtml(expTxt) + '</span>' +
          (s.subscriptionType ? ' &middot; sub <span class="stat-value">' + escapeHtml(s.subscriptionType) + '</span>' : '') +
          (s.defaultModel ? ' &middot; default <span class="stat-value">' + escapeHtml(s.defaultModel) + '</span>' : '');
        refreshBtn.style.display = 'inline-block';
        disconnectBtn.style.display = 'inline-block';
        loginBtn.textContent = 'Re-connect';
        modelsPanel.style.display = 'block';
      } else {
        statusEl.innerHTML = '<span class="status-warn">NOT CONNECTED</span> &middot; ' +
          '<span class="stat-label">login to enable claude-oauth/* brain models</span>';
        refreshBtn.style.display = 'none';
        disconnectBtn.style.display = 'none';
        loginBtn.textContent = 'Connect Claude (OAuth)';
        modelsPanel.style.display = 'none';
      }
    }

    function renderCoauthModels(models, defaultModel) {
      const sel = document.getElementById('coauth-models-select');
      const code = document.getElementById('coauth-model-string');
      sel.innerHTML = '';
      if (!models || models.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No models — click Refresh list';
        opt.disabled = true;
        sel.appendChild(opt);
        return;
      }
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.displayName + ' (' + m.id + ')';
        if (m.id === defaultModel) opt.selected = true;
        sel.appendChild(opt);
      }
      code.textContent = 'claude-oauth/' + (defaultModel || sel.value);
      sel.addEventListener('change', () => {
        code.textContent = 'claude-oauth/' + sel.value;
      }, { once: true });
    }

    async function refreshCoauthModels(forceLive) {
      const errEl = document.getElementById('coauth-models-error');
      errEl.style.display = 'none';
      try {
        const url = '/v1/admin/claude-oauth/models' + (forceLive ? '?refresh=1' : '');
        const data = await fetchJson(url);
        const payload = data.data || data;
        renderCoauthModels(payload.models, payload.defaultModel);
      } catch (e) {
        errEl.textContent = 'Models fetch failed: ' + e.message;
        errEl.style.display = 'block';
      }
    }

    document.getElementById('coauth-models-refresh-btn').addEventListener('click', () => refreshCoauthModels(true));

    document.getElementById('coauth-models-save-btn').addEventListener('click', async () => {
      const sel = document.getElementById('coauth-models-select');
      const errEl = document.getElementById('coauth-models-error');
      const id = sel.value;
      if (!id) {
        errEl.textContent = 'Pick a model first.';
        errEl.style.display = 'block';
        return;
      }
      try {
        const token = getToken();
        const res = await fetch('/v1/admin/claude-oauth/default-model', {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        errEl.style.display = 'none';
        await refreshCoauthStatus();
        await refreshCoauthModels(false);
      } catch (e) {
        errEl.textContent = 'Save failed: ' + e.message;
        errEl.style.display = 'block';
      }
    });

    // --- Grok model picker (GP6) -------------------------------------------
    function grokMethod() {
      return document.getElementById('grok-method-select').value;
    }
    function grokPrefix() {
      return grokMethod() === 'oauth' ? 'xai-oauth' : 'xai';
    }
    function renderGrokModels(models, defaultModel) {
      const sel = document.getElementById('grok-models-select');
      const code = document.getElementById('grok-model-string');
      sel.innerHTML = '';
      if (!models || models.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No models — click Refresh list';
        opt.disabled = true;
        sel.appendChild(opt);
        code.textContent = grokPrefix() + '/<id>';
        return;
      }
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        const ctx = m.contextWindow ? ' — ' + Math.round(m.contextWindow / 1000) + 'k ctx' : '';
        opt.textContent = m.name + ' (' + m.id + ')' + ctx;
        if (m.id === defaultModel) opt.selected = true;
        sel.appendChild(opt);
      }
      code.textContent = grokPrefix() + '/' + (defaultModel || sel.value);
    }
    async function refreshGrokModels(forceLive) {
      const errEl = document.getElementById('grok-models-error');
      errEl.style.display = 'none';
      try {
        const url = '/v1/admin/grok/models?method=' + grokMethod() + (forceLive ? '&refresh=1' : '');
        const data = await fetchJson(url);
        const payload = data.data || data;
        renderGrokModels(payload.models, payload.defaultModel);
      } catch (e) {
        errEl.textContent = 'Models fetch failed: ' + e.message;
        errEl.style.display = 'block';
        renderGrokModels([], null);
      }
    }
    async function refreshGrokStatus() {
      const el = document.getElementById('grok-status');
      try {
        const data = await fetchJson('/v1/admin/grok/status');
        const providers = (data.data || data).providers || [];
        el.innerHTML = providers.map(function (p) {
          const dot = p.connected ? '●' : '○';
          const bill = p.billing === 'subscription' ? 'subscription-covered' : 'pay-per-token';
          return '<div>' + dot + ' <strong>' + p.provider + '</strong> — ' +
            (p.connected ? 'ready' : 'not configured') +
            ' · default: ' + (p.defaultModel || '(none)') +
            ' · ' + bill + '</div>';
        }).join('');
      } catch (e) {
        el.innerHTML = '<span class="stat-label">Status unavailable: ' + e.message + '</span>';
      }
    }
    async function refreshGrokProviders() {
      await refreshGrokStatus();
      await refreshGrokModels(false);
    }
    document.getElementById('grok-method-select').addEventListener('change', () => refreshGrokModels(false));
    document.getElementById('grok-models-refresh-btn').addEventListener('click', () => refreshGrokModels(true));
    document.getElementById('grok-models-select').addEventListener('change', function () {
      document.getElementById('grok-model-string').textContent = grokPrefix() + '/' + this.value;
    });
    document.getElementById('grok-models-save-btn').addEventListener('click', async () => {
      const sel = document.getElementById('grok-models-select');
      const errEl = document.getElementById('grok-models-error');
      const id = sel.value;
      if (!id) { errEl.textContent = 'Pick a model first.'; errEl.style.display = 'block'; return; }
      try {
        const token = getToken();
        const res = await fetch('/v1/admin/grok/default-model', {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: grokMethod(), modelId: id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        errEl.style.display = 'none';
        await refreshGrokProviders();
      } catch (e) {
        errEl.textContent = 'Save failed: ' + e.message;
        errEl.style.display = 'block';
      }
    });
    refreshGrokProviders();

    async function refreshCoauthStatus() {
      try {
        const data = await fetchJson('/v1/admin/claude-oauth/status');
        renderCoauthStatus(data.data || data);
      } catch (e) {
        document.getElementById('coauth-status').innerHTML = '<span class="error">Status fetch failed: ' + escapeHtml(e.message) + '</span>';
      }
    }

    document.getElementById('coauth-login-btn').addEventListener('click', async () => {
      try {
        const data = await postJson('/v1/admin/claude-oauth/login/start');
        document.getElementById('coauth-login-panel').style.display = 'block';
        const link = document.getElementById('coauth-authorize-link');
        link.href = data.authorizeUrl;
        link.textContent = data.authorizeUrl;
        document.getElementById('coauth-code-input').value = '';
        document.getElementById('coauth-login-error').style.display = 'none';
      } catch (e) {
        alert('Login start failed: ' + e.message);
      }
    });

    document.getElementById('coauth-complete-btn').addEventListener('click', async () => {
      const code = document.getElementById('coauth-code-input').value.trim();
      const errEl = document.getElementById('coauth-login-error');
      if (!code) {
        errEl.textContent = 'Paste the authorization code first.';
        errEl.style.display = 'block';
        return;
      }
      try {
        await postJson('/v1/admin/claude-oauth/login/complete', { code });
        document.getElementById('coauth-login-panel').style.display = 'none';
        await refreshCoauthStatus();
      } catch (e) {
        errEl.textContent = 'Login failed: ' + e.message;
        errEl.style.display = 'block';
      }
    });

    document.getElementById('coauth-refresh-btn').addEventListener('click', async () => {
      try {
        await postJson('/v1/admin/claude-oauth/refresh');
        await refreshCoauthStatus();
      } catch (e) {
        alert('Refresh failed: ' + e.message);
      }
    });

    document.getElementById('coauth-disconnect-btn').addEventListener('click', async () => {
      if (!confirm('Wipe Claude OAuth credentials from sudo-ai? You will need to log in again.')) return;
      try {
        await postJson('/v1/admin/claude-oauth/disconnect');
        await refreshCoauthStatus();
      } catch (e) {
        alert('Disconnect failed: ' + e.message);
      }
    });

    async function refreshAll() {
      await Promise.allSettled([updateStats(), updateHealth(), updateAlignment(), updateActivity(), updateFleet(), refreshCoauthStatus()]);
      // Refresh models only when connected — avoids hitting the API on every
      // dashboard tick when the user has nothing wired up.
      const modelsPanel = document.getElementById('coauth-models-panel');
      if (modelsPanel && modelsPanel.style.display !== 'none') {
        refreshCoauthModels(false);
      }
      updateTimestamp();
    }

    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  </script>
</body>
</html>
`.trim();

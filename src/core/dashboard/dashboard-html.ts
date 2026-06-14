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

    async function refreshAll() {
      await Promise.allSettled([updateStats(), updateHealth(), updateAlignment(), updateActivity(), updateFleet()]);
      updateTimestamp();
    }

    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  </script>
</body>
</html>
`.trim();

// ============================================================
// admin-api.ts — typed fetch wrapper for all admin API calls
// ============================================================

export interface DashboardStats {
  cpu: number;
  memory: number;
  memoryUsedMB: number;
  memoryTotalMB: number;
  disk: number;
  uptime: number;
  platform: string;
  nodeVersion: string;
  activeSessions: number;
  tokensToday: number;
  costToday: number;
  agentActivity: { total: number; active: number };
  [key: string]: unknown;
}

let _token = '';

/** Call once at login / startup to set the bearer token. */
export function setAdminToken(token: string): void {
  _token = token;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

/**
 * Safely extract a nested value from a wrapped API response.
 * Tries each key in order; falls back to 'data', then the raw response.
 * If the response is already an array, return it directly.
 */
function extract<T>(response: unknown, ...keys: string[]): T {
  if (Array.isArray(response)) return response as T;
  const r = response as Record<string, unknown>;
  for (const key of keys) {
    if (r[key] !== undefined) return r[key] as T;
  }
  if (r.data !== undefined) return r.data as T;
  return response as T;
}

// Pino uses numeric log levels; normalise them to strings the UI expects.
const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function normalizeLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (typeof entry.level === 'number') {
    entry.level = PINO_LEVELS[entry.level] ?? 'info';
  }
  return entry;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export const fetchDashboardStats = () =>
  api<DashboardStats>('GET', '/api/admin/dashboard/stats');

export const restartService = () =>
  api<{ success: boolean }>('POST', '/api/admin/service/restart');

export const stopService = () =>
  api<{ success: boolean }>('POST', '/api/admin/service/stop');

// ─── Models ───────────────────────────────────────────────────────────────────

export const fetchModelsConfig = () =>
  api<unknown>('GET', '/api/admin/models/config')
    .then(r => extract<unknown>(r, 'data'));

export const updateModelsConfig = (config: unknown) =>
  api<unknown>('PUT', '/api/admin/models/config', config);

export const fetchProviders = () =>
  api<unknown>('GET', '/api/admin/models/providers')
    .then(r => extract<unknown[]>(r, 'data', 'providers'));

export const testProvider = (id: string) =>
  api<unknown>('POST', `/api/admin/models/providers/${id}/test`);

export const updateProviderKey = (id: string, key: string) =>
  api<unknown>('PUT', `/api/admin/models/providers/${id}/key`, { key });

// fetchModelCost returns a flat object { today, week, month, byModel } — pass through.
export const fetchModelCost = () =>
  api<unknown>('GET', '/api/admin/models/cost');

// ─── Channels ─────────────────────────────────────────────────────────────────

export const fetchChannels = () =>
  api<unknown>('GET', '/api/admin/channels')
    .then(r => extract<unknown[]>(r, 'channels'));

export const updateChannel = (type: string, config: unknown) =>
  api<unknown>('PUT', `/api/admin/channels/${type}`, config);

export const toggleChannel = (type: string, enabled: boolean) =>
  api<unknown>('POST', `/api/admin/channels/${type}/toggle`, { enabled });

export const testChannel = (type: string, message: string) =>
  api<unknown>('POST', `/api/admin/channels/${type}/test`, { message });

export const fetchChannelMessages = (type: string, limit = 50) =>
  api<unknown>('GET', `/api/admin/channels/${type}/messages?limit=${limit}`)
    .then(r => extract<unknown[]>(r, 'messages'));

// ─── Tools ────────────────────────────────────────────────────────────────────

export const fetchTools = () =>
  api<unknown>('GET', '/api/admin/tools')
    .then(r => extract<unknown[]>(r, 'tools'));

export const toggleTool = (name: string, enabled: boolean) =>
  api<unknown>('POST', `/api/admin/tools/${name}/toggle`, { enabled });

export const fetchToolStats = () =>
  api<unknown>('GET', '/api/admin/tools/stats')
    .then(r => extract<unknown>(r, 'stats'));

// ─── Consciousness ────────────────────────────────────────────────────────────

export const fetchConsciousnessState = () =>
  api<unknown>('GET', '/api/admin/consciousness/state');

export const fetchConsciousnessModules = () =>
  api<unknown>('GET', '/api/admin/consciousness/modules')
    .then(r => extract<unknown[]>(r, 'modules'));

export const fetchThoughts = (limit = 50) =>
  api<unknown>('GET', `/api/admin/consciousness/thoughts?limit=${limit}`)
    .then(r => extract<unknown[]>(r, 'thoughts'));

export const fetchEmotions = () =>
  api<unknown>('GET', '/api/admin/consciousness/emotions')
    .then(r => extract<unknown[]>(r, 'emotions'));

export const fetchBodyState = () =>
  api<unknown>('GET', '/api/admin/consciousness/body')
    .then(r => {
      // Response may be { bodyState: {...} } or { status, data: {...} }
      const unwrapped = extract<unknown>(r, 'bodyState', 'data');
      return unwrapped;
    });

export const fetchEpisodes = (limit = 20) =>
  api<unknown>('GET', `/api/admin/consciousness/episodes?limit=${limit}`)
    .then(r => extract<unknown[]>(r, 'episodes'));

// ─── Cron ─────────────────────────────────────────────────────────────────────

export const fetchCronJobs = () =>
  api<unknown>('GET', '/api/admin/cron/jobs')
    .then(r => extract<unknown[]>(r, 'jobs'));

export const createCronJob = (job: unknown) =>
  api<unknown>('POST', '/api/admin/cron/jobs', job);

export const updateCronJob = (id: string, updates: unknown) =>
  api<unknown>('PUT', `/api/admin/cron/jobs/${id}`, updates);

export const deleteCronJob = (id: string) =>
  api<unknown>('DELETE', `/api/admin/cron/jobs/${id}`);

export const toggleCronJob = (id: string, enabled: boolean) =>
  api<unknown>('POST', `/api/admin/cron/jobs/${id}/toggle`, { enabled });

export const runCronJob = (id: string) =>
  api<unknown>('POST', `/api/admin/cron/jobs/${id}/run`);

export const fetchCronHistory = (jobId?: string, limit = 50) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (jobId) params.set('jobId', jobId);
  return api<unknown>('GET', `/api/admin/cron/history?${params}`)
    .then(r => extract<unknown[]>(r, 'history', 'runs'));
};

// ─── Settings ─────────────────────────────────────────────────────────────────

export const fetchSettings = () =>
  api<unknown>('GET', '/api/admin/settings')
    .then(r => extract<unknown>(r, 'data'));

export const updateMeta = (meta: unknown) =>
  api<unknown>('PUT', '/api/admin/settings/meta', meta);

export const updateAgents = (agents: unknown) =>
  api<unknown>('PUT', '/api/admin/settings/agents', agents);

export const updateGateway = (gateway: unknown) =>
  api<unknown>('PUT', '/api/admin/settings/gateway', gateway);

export const fetchPersonas = () =>
  api<unknown>('GET', '/api/admin/settings/personas')
    .then(r => extract<unknown[]>(r, 'personas', 'data'));

export const setPersona = (id: string) =>
  api<unknown>('PUT', '/api/admin/settings/persona', { id });

// ─── Security ─────────────────────────────────────────────────────────────────

export const fetchApiTokens = () =>
  api<unknown>('GET', '/api/admin/security/tokens')
    .then(r => extract<unknown[]>(r, 'tokens'));

export const createApiToken = (name: string) =>
  api<unknown>('POST', '/api/admin/security/tokens', { name });

export const revokeApiToken = (id: string) =>
  api<unknown>('DELETE', `/api/admin/security/tokens/${id}`);

export const fetchCorsOrigins = () =>
  api<unknown>('GET', '/api/admin/security/cors')
    .then(r => {
      // Response may be { origins: [...] } or { status, data: { origins: [...] } }
      const unwrapped = extract<unknown>(r, 'origins');
      if (Array.isArray(unwrapped)) return unwrapped;
      // Nested: { status, data: { origins: [...] } }
      const nested = unwrapped as Record<string, unknown>;
      if (nested?.origins !== undefined) return nested.origins as unknown[];
      return unwrapped;
    });

export const updateCorsOrigins = (origins: string[]) =>
  api<unknown>('PUT', '/api/admin/security/cors', { origins });

export const fetchCredentials = () =>
  api<unknown>('GET', '/api/admin/security/credentials')
    .then(r => extract<unknown[]>(r, 'credentials'));

export const fetchAccessLog = (limit = 100) =>
  api<unknown>('GET', `/api/admin/security/access-log?limit=${limit}`)
    .then(r => extract<unknown[]>(r, 'entries'));

// ─── Logs ─────────────────────────────────────────────────────────────────────

export const fetchLogs = (level?: string, search?: string, limit = 200) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (level) params.set('level', level);
  if (search) params.set('search', search);
  return api<unknown>('GET', `/api/admin/logs?${params}`)
    .then(r => {
      const entries = extract<Record<string, unknown>[]>(r, 'entries');
      const normalized: unknown = Array.isArray(entries)
        ? entries.map(normalizeLogEntry)
        : entries;
      return normalized;
    });
};

export const downloadLogs = async () => {
  const headers: Record<string, string> = {};
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  const res = await fetch('/api/admin/logs/download', { headers });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.text();
};

// ─── System ───────────────────────────────────────────────────────────────────

export const fetchSystemInfo = () =>
  api<unknown>('GET', '/api/admin/system/info');

export const runDoctor = () =>
  api<unknown>('GET', '/api/admin/system/doctor');

export const createBackup = () =>
  api<unknown>('POST', '/api/admin/system/backup');

export const restoreBackup = (path: string) =>
  api<unknown>('POST', '/api/admin/system/restore', { path });

export const fetchDatabases = () =>
  api<unknown>('GET', '/api/admin/system/databases')
    .then(r => extract<unknown[]>(r, 'databases'));

export const fetchEnvVars = () =>
  api<unknown>('GET', '/api/admin/system/env')
    .then(r => extract<unknown>(r, 'env', 'vars', 'data'));

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const fetchSessions = (state?: string, limit = 50) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (state) params.set('state', state);
  return api<unknown>('GET', `/api/admin/sessions?${params}`)
    .then(r => extract<unknown[]>(r, 'sessions'));
};

export const fetchSession = (id: string) =>
  api<unknown>('GET', `/api/admin/sessions/${id}`)
    .then(r => extract<unknown>(r, 'session', 'data'));

export const deleteSession = (id: string) =>
  api<unknown>('DELETE', `/api/admin/sessions/${id}`);

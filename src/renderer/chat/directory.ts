/**
 * Directory client — talks to the backend /api/directory endpoints.
 * Same-origin fetch, carrying the ?token= web-chat token when present.
 */

export interface SkillItem {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  capabilities?: string[];
  tags?: string[];
}

export interface ConnectorItem {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  transport?: 'http' | 'stdio';
  authEnvKey?: string;
  live?: boolean;
  requiresOAuth?: boolean;
  verified?: boolean;
  tags?: string[];
}

export interface PluginItem {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  skills?: string[];
  connectors?: string[];
  tags?: string[];
}

export interface DirectoryData {
  ok: boolean;
  skills: SkillItem[];
  connectors: ConnectorItem[];
  plugins: PluginItem[];
  sources: Record<string, string | null>;
  errors: Record<string, string>;
}

export type DirectoryKind = 'skill' | 'connector' | 'plugin';

export interface InstallResult {
  ok: boolean;
  kind?: DirectoryKind;
  name?: string;
  dryRun?: boolean;
  output?: string;
  error?: string;
  data?: unknown;
}

function tokenQuery(): string {
  try {
    const t = new URLSearchParams(window.location.search).get('token');
    return t ? `?token=${encodeURIComponent(t)}` : '';
  } catch {
    return '';
  }
}

function authHeaders(): Record<string, string> {
  try {
    const t = new URLSearchParams(window.location.search).get('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

export async function fetchDirectory(): Promise<DirectoryData> {
  const res = await fetch(`/api/directory${tokenQuery()}`, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`Directory fetch failed: HTTP ${res.status}`);
  return (await res.json()) as DirectoryData;
}

export async function installItem(kind: DirectoryKind, name: string, dryRun = false): Promise<InstallResult> {
  const res = await fetch(`/api/directory/install${tokenQuery()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ kind, name, dryRun }),
  });
  return (await res.json()) as InstallResult;
}

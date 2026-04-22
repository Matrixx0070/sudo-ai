import React, { useEffect, useState, useCallback } from 'react';
import { Tabs } from '@renderer/components/common/Tabs.js';
import { DataTable } from '@renderer/components/common/DataTable.js';
import { StatusDot } from '@renderer/components/common/StatusDot.js';
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';

interface ApiToken { id: string; name: string; prefix: string; createdAt: string; lastUsed: string }
interface Credential { key: string; maskedValue: string; updatedAt: string }
interface AccessLogEntry { ip: string; method: string; path: string; status: number; timestamp: string }

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function statusColor(code: number): string {
  if (code >= 500) return '#ef4444';
  if (code >= 400) return '#eab308';
  if (code >= 200) return '#22c55e';
  return '#9ca3af';
}
function Btn({ children, onClick, disabled, variant = 'primary' }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; variant?: 'primary' | 'danger' }) {
  const [hov, setHov] = useState(false);
  const isPrimary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: isPrimary ? '8px 16px' : '5px 12px',
        borderRadius: isPrimary ? '8px' : '6px',
        border: isPrimary ? 'none' : '1px solid #7f1d1d',
        backgroundColor: isPrimary ? (hov ? '#2563eb' : '#3b82f6') : hov ? 'rgba(239,68,68,0.2)' : 'transparent',
        color: isPrimary ? '#fff' : '#f87171',
        fontSize: isPrimary ? '13px' : '12px',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background-color 150ms ease',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {children}
    </button>
  );
}

function ApiTokensTab() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);

  const load = useCallback(() => {
    api.fetchApiTokens().then((d) => { setTokens(d as ApiToken[]); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const result = await api.createApiToken(newName.trim()) as { id: string; token: string; name: string };
      setNewToken({ name: result.name, token: result.token });
      setNewName('');
      load();
    } catch { /* ignore */ }
    finally { setCreating(false); }
  }, [newName, load]);

  const handleRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    try {
      await api.revokeApiToken(revokeTarget.id);
      setTokens((prev) => prev.filter((t) => t.id !== revokeTarget.id));
    } catch { /* ignore */ }
    finally { setRevokeTarget(null); }
  }, [revokeTarget]);

  const handleCopy = useCallback(() => {
    if (newToken) {
      void navigator.clipboard.writeText(newToken.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [newToken]);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;

  return (
    <div style={{ padding: '20px 0' }}>
      {newToken && (
        <div role="alert" style={{ marginBottom: '20px', padding: '14px 16px', borderRadius: '8px', backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)' }}>
          <p style={{ margin: '0 0 8px', fontSize: '13px', color: '#4ade80', fontWeight: 600 }}>Token created for "{newToken.name}" — copy it now, it won't be shown again.</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <code style={{ flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: '6px', backgroundColor: '#111827', border: '1px solid #1f2937', color: '#e5e7eb', fontSize: '12px', wordBreak: 'break-all', fontFamily: 'monospace' }}>
              {newToken.token}
            </code>
            <Btn onClick={handleCopy}>{copied ? 'Copied!' : 'Copy'}</Btn>
            <button onClick={() => setNewToken(null)} aria-label="Dismiss token" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '16px' }}>&#x2715;</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
          placeholder="Token name (e.g. my-integration)"
          aria-label="New token name"
          style={{ flex: '1 1 200px', padding: '7px 12px', borderRadius: '8px', border: '1px solid #1f2937', backgroundColor: '#111827', color: '#f9fafb', fontSize: '13px', fontFamily: 'Inter, system-ui, sans-serif', outline: 'none' }}
        />
        <Btn onClick={() => void handleCreate()} disabled={creating || !newName.trim()}>
          {creating ? 'Generating...' : 'Generate New Token'}
        </Btn>
      </div>

      <DataTable<Record<string, unknown>>
        columns={[
          { key: 'name', header: 'Name', width: '25%' },
          { key: 'prefix', header: 'Prefix', width: '18%', render: (row) => <code style={{ fontSize: '12px', fontFamily: 'monospace', color: '#9ca3af' }}>{String(row['prefix']).slice(0, 8)}...</code> },
          { key: 'createdAt', header: 'Created', width: '22%', render: (row) => fmtDate(String(row['createdAt'])) },
          { key: 'lastUsed', header: 'Last Used', width: '22%', render: (row) => row['lastUsed'] ? fmtDate(String(row['lastUsed'])) : <span style={{ color: '#6b7280' }}>Never</span> },
          { key: 'id', header: '', width: '13%', render: (row) => <Btn variant="danger" onClick={() => setRevokeTarget(tokens.find((t) => t.id === row['id']) ?? null)}>Revoke</Btn> },
        ]}
        data={tokens as unknown as Record<string, unknown>[]}
        keyField="id"
        emptyMessage="No API tokens. Generate one above."
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke API Token"
        message={`Revoke token "${revokeTarget?.name}"? Any integrations using this token will lose access immediately.`}
        confirmLabel="Revoke"
        danger
        onConfirm={() => void handleRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}

function CorsTab() {
  const [origins, setOrigins] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.fetchCorsOrigins().then((d) => { const arr = d as string[]; setOrigins(arr); setDraft(arr.join('\n')); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const list = draft.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await api.updateCorsOrigins(list);
      setOrigins(list);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }, [draft]);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;

  return (
    <div style={{ padding: '20px 0', maxWidth: '640px' }}>
      <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#9ca3af' }}>One origin per line. Changes take effect immediately after saving.</p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="CORS allowed origins"
        rows={10}
        style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid #1f2937', backgroundColor: '#111827', color: '#e5e7eb', fontSize: '13px', fontFamily: 'monospace', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' }}>
        <Btn onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving...' : 'Save Origins'}</Btn>
        {saved && <span style={{ fontSize: '13px', color: '#22c55e' }}>Saved.</span>}
      </div>
      {origins.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current ({origins.length})</p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {origins.map((o) => (
              <li key={o} style={{ fontSize: '13px', color: '#9ca3af', padding: '4px 8px', backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '6px', fontFamily: 'monospace' }}>{o}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CredentialsTab() {
  const [creds, setCreds] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchCredentials().then((d) => { setCreds(d as Credential[]); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;

  return (
    <div style={{ padding: '20px 0' }}>
      <p style={{ margin: '0 0 16px', fontSize: '13px', color: '#6b7280' }}>Read-only view. Edit credentials via environment variables or your secrets manager.</p>
      <DataTable<Record<string, unknown>>
        columns={[
          { key: 'status', header: '', width: '40px', render: (row) => <StatusDot status={row['maskedValue'] ? 'online' : 'error'} /> },
          { key: 'key', header: 'Key', width: '35%', render: (row) => <code style={{ fontSize: '12px', fontFamily: 'monospace', color: '#e5e7eb' }}>{String(row['key'])}</code> },
          { key: 'maskedValue', header: 'Value', width: '35%', render: (row) => <code style={{ fontSize: '12px', fontFamily: 'monospace', color: '#9ca3af' }}>{row['maskedValue'] ? String(row['maskedValue']) : <span style={{ color: '#ef4444' }}>not set</span>}</code> },
          { key: 'updatedAt', header: 'Updated', width: '20%', render: (row) => row['updatedAt'] ? fmtDate(String(row['updatedAt'])) : '—' },
        ]}
        data={creds as unknown as Record<string, unknown>[]}
        keyField="key"
        emptyMessage="No credentials configured."
      />
    </div>
  );
}

function AccessLogTab() {
  const [log, setLog] = useState<AccessLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchAccessLog(100).then((d) => { setLog(d as AccessLogEntry[]); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;

  return (
    <div style={{ padding: '20px 0' }}>
      <DataTable<Record<string, unknown>>
        columns={[
          { key: 'timestamp', header: 'Time', width: '22%', sortable: true, render: (row) => fmtDate(String(row['timestamp'])) },
          { key: 'ip', header: 'IP', width: '16%', render: (row) => <code style={{ fontSize: '12px', fontFamily: 'monospace', color: '#9ca3af' }}>{String(row['ip'])}</code> },
          { key: 'method', header: 'Method', width: '10%', render: (row) => <span style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa' }}>{String(row['method'])}</span> },
          { key: 'path', header: 'Path', width: '32%', render: (row) => <code style={{ fontSize: '12px', fontFamily: 'monospace', color: '#d1d5db' }}>{String(row['path'])}</code> },
          { key: 'status', header: 'Status', width: '10%', sortable: true, render: (row) => <span style={{ fontWeight: 700, fontSize: '13px', color: statusColor(Number(row['status'])) }}>{String(row['status'])}</span> },
        ]}
        data={log as unknown as Record<string, unknown>[]}
        keyField="timestamp"
        emptyMessage="No access log entries."
      />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'tokens',      label: 'API Tokens'  },
  { id: 'cors',        label: 'CORS'        },
  { id: 'credentials', label: 'Credentials' },
  { id: 'access-log',  label: 'Access Log'  },
];

export function SecurityPage() {
  const [activeTab, setActiveTab] = useState('tokens');

  return (
    <main style={{ padding: '24px', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#0a0e1a', minHeight: '100%' }}>
      <header style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>Security</h1>
        <p style={{ margin: 0, fontSize: '13px', color: '#6b7280' }}>API tokens, CORS policy, credentials, and access log</p>
      </header>

      <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

      <section id={`tabpanel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'tokens'      && <ApiTokensTab />}
        {activeTab === 'cors'        && <CorsTab />}
        {activeTab === 'credentials' && <CredentialsTab />}
        {activeTab === 'access-log'  && <AccessLogTab />}
      </section>
    </main>
  );
}

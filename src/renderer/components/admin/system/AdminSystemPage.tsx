import React, { useEffect, useState, useCallback } from 'react';
import { Card } from '@renderer/components/common/Card.js';
import { Tabs } from '@renderer/components/common/Tabs.js';
import { DataTable } from '@renderer/components/common/DataTable.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';

// ─── local types ──────────────────────────────────────────────────────────────

interface SystemInfo {
  pid?: number;
  memoryMB?: number;
  cpuPercent?: number;
  uptime?: number;
  nodeVersion?: string;
  platform?: string;
  hostname?: string;
}

interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
}

interface DoctorResult {
  healthy?: boolean;
  checks?: DoctorCheck[];
}

interface Database {
  name: string;
  sizeMB: number;
  tables?: number;
}

interface EnvRow extends Record<string, unknown> {
  key: string;
  value: string;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d > 0 ? `${d}d` : null, `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

function maskValue(v: string): string {
  if (!v) return '—';
  const lower = v.toLowerCase();
  const sensitive =
    lower.includes('key') ||
    lower.includes('secret') ||
    lower.includes('token') ||
    lower.includes('password') ||
    lower.includes('pass') ||
    lower.includes('auth');
  if (sensitive) return '••••••••';
  return v.length > 60 ? `${v.slice(0, 60)}…` : v;
}

const DOCTOR_COLORS: Record<string, string> = {
  pass: '#22c55e',
  warn: '#eab308',
  fail: '#ef4444',
};

const DOCTOR_ICONS: Record<string, string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
};

// ─── InfoRow ──────────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '9px 0',
        borderBottom: '1px solid #1f2937',
        fontSize: '13px',
      }}
    >
      <span style={{ color: '#9ca3af' }}>{label}</span>
      <span style={{ color: '#f9fafb', fontWeight: 600, fontFamily: 'monospace' }}>
        {value ?? '—'}
      </span>
    </div>
  );
}

// ─── tab panels ───────────────────────────────────────────────────────────────

function InfoPanel({ sysInfo, loading }: { sysInfo: SystemInfo | null; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
        <Spinner size="lg" />
      </div>
    );
  }
  const info = sysInfo ?? {};
  return (
    <Card title="Process Information">
      <InfoRow label="PID" value={info.pid} />
      <InfoRow label="Hostname" value={info.hostname} />
      <InfoRow label="Platform" value={info.platform} />
      <InfoRow label="Node version" value={info.nodeVersion} />
      <InfoRow label="Memory (MB)" value={info.memoryMB != null ? `${info.memoryMB} MB` : undefined} />
      <InfoRow label="CPU %" value={info.cpuPercent != null ? `${info.cpuPercent}%` : undefined} />
      <InfoRow label="Uptime" value={info.uptime != null ? formatUptime(info.uptime) : undefined} />
    </Card>
  );
}

function DoctorPanel() {
  const [result, setResult] = useState<DoctorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  async function runCheck() {
    setLoading(true);
    try {
      const res = await api.runDoctor();
      setResult(res as DoctorResult);
      setRan(true);
    } catch {
      setResult({ healthy: false, checks: [] });
      setRan(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="Health Check" subtitle="Run a diagnostic on all system components">
      <div style={{ marginBottom: '16px' }}>
        <button
          onClick={() => { void runCheck(); }}
          disabled={loading}
          style={{
            padding: '8px 18px',
            borderRadius: '8px',
            border: 'none',
            backgroundColor: '#3b82f6',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1,
            fontFamily: 'Inter, system-ui, sans-serif',
          }}
        >
          {loading ? 'Running…' : ran ? 'Run Again' : 'Run Doctor'}
        </button>
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#9ca3af', fontSize: '13px' }}>
          <Spinner size="sm" /> Running checks…
        </div>
      )}

      {!loading && ran && result && (
        <div>
          <p
            style={{
              margin: '0 0 12px',
              fontSize: '13px',
              fontWeight: 600,
              color: result.healthy ? '#22c55e' : '#ef4444',
            }}
            role="status"
            aria-live="polite"
          >
            System is {result.healthy ? 'healthy' : 'unhealthy'}
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {(result.checks ?? []).map((c, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  backgroundColor: '#0a0e1a',
                  border: `1px solid ${DOCTOR_COLORS[c.status] ?? '#1f2937'}33`,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    fontWeight: 700,
                    color: DOCTOR_COLORS[c.status] ?? '#9ca3af',
                    width: '14px',
                    flexShrink: 0,
                    fontSize: '14px',
                    lineHeight: '18px',
                  }}
                >
                  {DOCTOR_ICONS[c.status] ?? '?'}
                </span>
                <div>
                  <span style={{ fontSize: '13px', color: '#f9fafb', fontWeight: 600 }}>{c.name}</span>
                  {c.message && (
                    <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#9ca3af' }}>{c.message}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

interface BackupRecord {
  path: string;
  sizeMB: number;
  createdAt: string;
}

function BackupPanel() {
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<BackupRecord[]>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  async function handleBackup() {
    setPending(true);
    setStatusMsg(null);
    try {
      const res = await api.createBackup() as { success?: boolean; path?: string; sizeMB?: number };
      if (res.success && res.path) {
        const entry: BackupRecord = {
          path: res.path,
          sizeMB: res.sizeMB ?? 0,
          createdAt: new Date().toLocaleString(),
        };
        setHistory((h) => [entry, ...h]);
        setStatusMsg('Backup created successfully.');
      } else {
        setStatusMsg('Backup failed.');
      }
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <Card title="Create Backup" subtitle="Export a full system snapshot to disk">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button
            onClick={() => { void handleBackup(); }}
            disabled={pending}
            style={{
              padding: '8px 18px',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600,
              cursor: pending ? 'not-allowed' : 'pointer',
              opacity: pending ? 0.7 : 1,
              fontFamily: 'Inter, system-ui, sans-serif',
            }}
          >
            {pending ? 'Creating…' : 'Create Backup'}
          </button>
          {pending && <Spinner size="sm" />}
          {statusMsg && (
            <span role="status" aria-live="polite" style={{ fontSize: '13px', color: '#9ca3af' }}>
              {statusMsg}
            </span>
          )}
        </div>
      </Card>

      {history.length > 0 && (
        <Card title="Backup History">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {history.map((b, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: i < history.length - 1 ? '1px solid #1f2937' : 'none',
                  fontSize: '13px',
                }}
              >
                <span style={{ color: '#f9fafb', fontFamily: 'monospace', fontSize: '12px' }}>
                  {b.path}
                </span>
                <span style={{ color: '#9ca3af', flexShrink: 0, marginLeft: '16px' }}>
                  {b.sizeMB} MB &middot; {b.createdAt}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function DatabasesPanel() {
  const [dbs, setDbs] = useState<Database[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchDatabases()
      .then((res) => {
        const data = res as { databases?: Database[] };
        setDbs(Array.isArray(data?.databases) ? data.databases : []);
      })
      .catch(() => setDbs([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (dbs.length === 0) {
    return (
      <Card>
        <p style={{ color: '#9ca3af', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>
          No databases found.
        </p>
      </Card>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: '16px',
      }}
    >
      {dbs.map((db) => (
        <Card key={db.name} title={db.name}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#3b82f6' }}>
              {db.sizeMB} <span style={{ fontSize: '13px', color: '#9ca3af', fontWeight: 400 }}>MB</span>
            </div>
            {db.tables != null && (
              <div style={{ fontSize: '12px', color: '#9ca3af' }}>{db.tables} tables</div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function EnvironmentPanel() {
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchEnvVars()
      .then((res) => {
        const record = res as Record<string, string>;
        const mapped: EnvRow[] = Object.entries(record ?? {}).map(([key, value]) => ({
          key,
          value: maskValue(key + value),
        }));
        setRows(mapped);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  const columns = [
    { key: 'key', header: 'Variable', sortable: true, width: '40%' },
    { key: 'value', header: 'Value', width: '60%' },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      keyField="key"
      emptyMessage="No environment variables found."
    />
  );
}

// ─── main component ───────────────────────────────────────────────────────────

const TABS = [
  { id: 'info', label: 'Info' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'backup', label: 'Backup' },
  { id: 'databases', label: 'Databases' },
  { id: 'environment', label: 'Environment' },
];

export function AdminSystemPage() {
  const [activeTab, setActiveTab] = useState('info');
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [sysLoading, setSysLoading] = useState(true);

  const loadInfo = useCallback(async () => {
    try {
      const data = await api.fetchSystemInfo();
      setSysInfo(data as SystemInfo);
    } catch {
      // keep previous on error
    } finally {
      setSysLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  return (
    <main
      aria-label="System Management"
      style={{
        padding: '24px',
        backgroundColor: '#0a0e1a',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
      }}
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontSize: '20px',
            fontWeight: 700,
            color: '#f9fafb',
            fontFamily: 'Inter, system-ui, sans-serif',
          }}
        >
          System
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>
          Process info, health checks, backups, and configuration
        </p>
      </header>

      <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

      <div
        id={`tabpanel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'info' && <InfoPanel sysInfo={sysInfo} loading={sysLoading} />}
        {activeTab === 'doctor' && <DoctorPanel />}
        {activeTab === 'backup' && <BackupPanel />}
        {activeTab === 'databases' && <DatabasesPanel />}
        {activeTab === 'environment' && <EnvironmentPanel />}
      </div>
    </main>
  );
}

import React, { useEffect, useState } from 'react';
import { Card } from '../../common/Card.js';
import { StatusDot } from '../../common/StatusDot.js';
import { Spinner } from '../../common/Spinner.js';
import {
  fetchModelsConfig,
  updateModelsConfig,
  fetchProviders,
  testProvider,
  updateProviderKey,
  fetchModelCost,
} from '../../../lib/admin-api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

interface ModelsConfig {
  primary: ModelEntry[] | string;
  fallback: ModelEntry | string;
  temperature: number;
  maxOutputTokens: number;
  [key: string]: unknown;
}

interface Provider {
  id: string;
  name: string;
  hasKey: boolean;
  models: string[];
}

interface CostData {
  today: number;
  week: number;
  month: number;
}

// ─── Shared styles ────────────────────────────────────────────────────────────

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  backgroundColor: '#0a0e1a',
  border: '1px solid #1f2937',
  borderRadius: '6px',
  color: '#f9fafb',
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
};

export const btnPrimary: React.CSSProperties = {
  padding: '7px 14px',
  backgroundColor: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

export const btnSecondary: React.CSSProperties = {
  padding: '7px 14px',
  backgroundColor: '#1f2937',
  color: '#d1d5db',
  border: '1px solid #374151',
  borderRadius: '6px',
  fontSize: '13px',
  cursor: 'pointer',
};

// ─── Active Models ─────────────────────────────────────────────────────────────

function ActiveModelsSection() {
  const [config, setConfig] = useState<ModelsConfig | null>(null);
  const [draft, setDraft] = useState<ModelsConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchModelsConfig().then((d: unknown) => {
      const data = d as { models?: ModelsConfig } & ModelsConfig;
      const cfg = data.models ? (data.models as unknown as ModelsConfig) : data;
      setConfig(cfg);
      setDraft(cfg);
    }).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try { await updateModelsConfig(draft); setConfig(draft); setEditing(false); }
    finally { setSaving(false); }
  };

  const field = (label: string, key: keyof ModelsConfig, type: 'text' | 'number' = 'text') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: 500 }}>{label}</label>
      {editing && draft ? (
        <input
          type={type}
          value={draft[key] as string | number}
          onChange={(e) => setDraft({ ...draft, [key]: type === 'number' ? Number(e.target.value) : e.target.value })}
          style={inputStyle}
          aria-label={label}
        />
      ) : (
        <span style={{ fontSize: '13px', color: '#f9fafb' }}>{config ? String((() => {
          const v = config[key];
          if (Array.isArray(v)) return v.map((m: Record<string, unknown>) => m.id ?? String(m)).join(', ');
          if (typeof v === 'object' && v !== null) return (v as Record<string, unknown>).id ?? JSON.stringify(v);
          return v !== undefined && v !== null ? String(v) : '—';
        })()) : '—'}</span>
      )}
    </div>
  );

  return (
    <Card title="Active Models" subtitle="Primary model configuration">
      {loading ? <Spinner /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
            {field('Primary Model', 'primary')}
            {field('Fallback Model', 'fallback')}
            {field('Temperature', 'temperature', 'number')}
            {field('Max Output Tokens', 'maxOutputTokens', 'number')}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {editing ? (
              <>
                <button style={btnPrimary} onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                <button style={btnSecondary} onClick={() => { setDraft(config); setEditing(false); }}>Cancel</button>
              </>
            ) : (
              <button style={btnPrimary} onClick={() => setEditing(true)}>Edit</button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Provider Card ─────────────────────────────────────────────────────────────

function ProviderCard({ provider }: { provider: Provider }) {
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; latencyMs?: number; error?: string } | null>(null);

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await testProvider(provider.id) as { success: boolean; latencyMs?: number; error?: string };
      setTestResult(res);
    } catch (e) { setTestResult({ success: false, error: String(e) }); }
    finally { setTesting(false); }
  };

  const handleSaveKey = async () => {
    setSaving(true);
    try { await updateProviderKey(provider.id, key); setKey(''); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div aria-hidden="true" style={{ width: 32, height: 32, borderRadius: '8px', backgroundColor: '#1f2937', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, color: '#3b82f6', flexShrink: 0 }}>
          {provider.name.charAt(0)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#f9fafb' }}>{provider.name}</div>
          <div style={{ fontSize: '11px', color: '#6b7280' }}>{(provider.models ?? []).length} model{(provider.models ?? []).length !== 1 ? 's' : ''}</div>
        </div>
        <StatusDot status={provider.hasKey ? 'online' : 'offline'} />
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        <input type={showKey ? 'text' : 'password'} placeholder="API Key" value={key} onChange={(e) => setKey(e.target.value)} style={{ ...inputStyle, flex: 1 }} aria-label={`${provider.name} API key`} />
        <button style={btnSecondary} onClick={() => setShowKey(!showKey)} aria-label={showKey ? 'Hide key' : 'Show key'}>{showKey ? 'Hide' : 'Show'}</button>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button style={btnSecondary} onClick={handleTest} disabled={testing} aria-busy={testing}>{testing ? 'Testing…' : 'Test Connection'}</button>
        <button style={btnPrimary} onClick={handleSaveKey} disabled={!key || saving}>{saving ? 'Saving…' : 'Save Key'}</button>
      </div>
      {testResult && (
        <div role="status" style={{ fontSize: '12px', padding: '6px 10px', borderRadius: '6px', backgroundColor: testResult.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: testResult.success ? '#22c55e' : '#ef4444', border: `1px solid ${testResult.success ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}` }}>
          {testResult.success ? `Connected — ${testResult.latencyMs ?? '?'}ms` : `Failed: ${testResult.error ?? 'Unknown error'}`}
        </div>
      )}
    </div>
  );
}

function ProvidersSection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProviders().then((d: unknown) => setProviders(d as Provider[])).finally(() => setLoading(false));
  }, []);

  return (
    <section aria-labelledby="providers-heading">
      <h2 id="providers-heading" style={{ margin: '0 0 12px', fontSize: '15px', fontWeight: 600, color: '#f9fafb' }}>Providers</h2>
      {loading ? <Spinner /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '14px' }}>
          {providers.map((p) => <ProviderCard key={p.id} provider={p} />)}
        </div>
      )}
    </section>
  );
}

// ─── Cost Tracking ─────────────────────────────────────────────────────────────

function CostSection() {
  const [costs, setCosts] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchModelCost().then((d: unknown) => {
      const raw = d as Record<string, unknown>;
      setCosts({
        today: typeof raw.today === 'number' ? raw.today : 0,
        week: typeof raw.week === 'number' ? raw.week : 0,
        month: typeof raw.month === 'number' ? raw.month : 0,
      });
    }).finally(() => setLoading(false));
  }, []);

  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const metric = (label: string, value: number) => (
    <div style={{ flex: '1 1 120px', backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '10px', padding: '16px', textAlign: 'center' }}>
      <div style={{ fontSize: '22px', fontWeight: 700, color: '#f9fafb' }}>{fmt(value)}</div>
      <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>{label}</div>
    </div>
  );

  return (
    <section aria-labelledby="cost-heading">
      <h2 id="cost-heading" style={{ margin: '0 0 12px', fontSize: '15px', fontWeight: 600, color: '#f9fafb' }}>Cost Tracking</h2>
      {loading ? <Spinner /> : costs ? (
        <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
          {metric('Today', costs.today)}
          {metric('This Week', costs.week)}
          {metric('This Month', costs.month)}
        </div>
      ) : <p style={{ color: '#9ca3af', fontSize: '13px' }}>No cost data available.</p>}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ModelsPage() {
  return (
    <main style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: '1100px', margin: '0 auto', fontFamily: 'Inter, system-ui, sans-serif', color: '#f9fafb' }} aria-label="AI Models management">
      <header>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>AI Models</h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>Configure models, providers, and track API costs.</p>
      </header>
      <ActiveModelsSection />
      <ProvidersSection />
      <CostSection />
    </main>
  );
}

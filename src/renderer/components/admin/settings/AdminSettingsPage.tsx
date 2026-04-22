import React, { useEffect, useState } from 'react';
import { Tabs } from '../../common/Tabs.js';
import { Toggle } from '../../common/Toggle.js';
import { CodeEditor } from '../../common/CodeEditor.js';
import { Spinner } from '../../common/Spinner.js';
import {
  fetchSettings,
  updateMeta,
  updateAgents,
  updateGateway,
  fetchPersonas,
  setPersona,
} from '../../../lib/admin-api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Meta { instanceName: string; timezone: string; }
interface AgentSettings { maxIterations: number; systemPrompt: string; }
interface GatewaySettings { enabled: boolean; port: number; corsOrigins: string; rateLimit: number; }
interface Persona { id: string; name: string; description: string; }

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', backgroundColor: '#0a0e1a', border: '1px solid #1f2937', borderRadius: '6px', color: '#f9fafb', fontSize: '13px', outline: 'none', boxSizing: 'border-box' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px', color: '#9ca3af', fontWeight: 500 };
const btnPrimary: React.CSSProperties = { padding: '8px 18px', backgroundColor: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' };
const formCol: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px' };

// ─── General Tab ──────────────────────────────────────────────────────────────

function GeneralTab({ initial }: { initial: Meta }) {
  const [form, setForm] = useState<Meta>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try { await updateMeta(form); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    finally { setSaving(false); }
  };

  return (
    <div style={formCol}>
      <label style={labelStyle}>
        Instance Name
        <input type="text" value={form.instanceName} onChange={(e) => setForm({ ...form, instanceName: e.target.value })} style={inputStyle} aria-label="Instance name" />
      </label>
      <label style={labelStyle}>
        Timezone
        <input type="text" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} style={inputStyle} aria-label="Timezone" placeholder="e.g. Asia/Karachi" />
      </label>
      <button style={btnPrimary} onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}</button>
    </div>
  );
}

// ─── Agents Tab ───────────────────────────────────────────────────────────────

function AgentsTab({ initial }: { initial: AgentSettings }) {
  const [form, setForm] = useState<AgentSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try { await updateAgents(form); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    finally { setSaving(false); }
  };

  return (
    <div style={formCol}>
      <label style={labelStyle}>
        Max Iterations (1–1000)
        <input type="number" min={1} max={1000} value={form.maxIterations} onChange={(e) => setForm({ ...form, maxIterations: Math.min(1000, Math.max(1, Number(e.target.value))) })} style={{ ...inputStyle, maxWidth: '160px' }} aria-label="Max iterations" />
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        <span style={{ fontSize: '12px', color: '#9ca3af', fontWeight: 500 }}>System Prompt</span>
        <CodeEditor value={form.systemPrompt} onChange={(val) => setForm({ ...form, systemPrompt: val })} language="markdown" height="220px" />
      </div>
      <button style={btnPrimary} onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}</button>
    </div>
  );
}

// ─── Gateway Tab ──────────────────────────────────────────────────────────────

function GatewayTab({ initial }: { initial: GatewaySettings }) {
  const [form, setForm] = useState<GatewaySettings>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { ...form, corsOrigins: form.corsOrigins.split('\n').map((s) => s.trim()).filter(Boolean) };
      await updateGateway(payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  return (
    <div style={formCol}>
      <Toggle label="Enable Gateway" checked={form.enabled} onChange={(checked) => setForm({ ...form, enabled: checked })} />
      <label style={labelStyle}>
        Port
        <input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} style={{ ...inputStyle, maxWidth: '160px' }} aria-label="Gateway port" />
      </label>
      <label style={labelStyle}>
        CORS Origins (one per line)
        <textarea value={form.corsOrigins} onChange={(e) => setForm({ ...form, corsOrigins: e.target.value })} rows={4} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} aria-label="CORS origins" placeholder="https://example.com" />
      </label>
      <label style={labelStyle}>
        Rate Limit (requests/min)
        <input type="number" min={1} value={form.rateLimit} onChange={(e) => setForm({ ...form, rateLimit: Number(e.target.value) })} style={{ ...inputStyle, maxWidth: '160px' }} aria-label="Rate limit" />
      </label>
      <button style={btnPrimary} onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}</button>
    </div>
  );
}

// ─── Persona Tab ──────────────────────────────────────────────────────────────

function PersonaTab() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPersonas().then((d: unknown) => setPersonas(d as Persona[])).finally(() => setLoading(false));
  }, []);

  const handleSelect = async (id: string) => { setActiveId(id); await setPersona(id); };

  if (loading) return <Spinner />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '14px' }} role="listbox" aria-label="Select persona">
      {personas.map((p) => {
        const isActive = p.id === activeId;
        return (
          <button key={p.id} role="option" aria-selected={isActive} onClick={() => handleSelect(p.id)}
            style={{ backgroundColor: '#111827', border: `2px solid ${isActive ? '#3b82f6' : '#1f2937'}`, borderRadius: '10px', padding: '16px', textAlign: 'left', cursor: 'pointer', transition: 'border-color 150ms ease', boxShadow: isActive ? '0 0 0 3px rgba(59,130,246,0.2)' : 'none', outline: 'none' }}
            onFocus={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = '#374151'; }}
            onBlur={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = '#1f2937'; }}
          >
            <div style={{ fontSize: '13px', fontWeight: 600, color: isActive ? '#3b82f6' : '#f9fafb', marginBottom: '6px' }}>{p.name}</div>
            <div style={{ fontSize: '12px', color: '#9ca3af', lineHeight: 1.5 }}>{p.description}</div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [{ id: 'general', label: 'General' }, { id: 'agents', label: 'Agents' }, { id: 'gateway', label: 'Gateway' }, { id: 'persona', label: 'Persona' }];
const DEFAULT_META: Meta = { instanceName: '', timezone: '' };
const DEFAULT_AGENTS: AgentSettings = { maxIterations: 100, systemPrompt: '' };
const DEFAULT_GATEWAY: GatewaySettings = { enabled: false, port: 3001, corsOrigins: '', rateLimit: 60 };

export function AdminSettingsPage() {
  const [activeTab, setActiveTab] = useState('general');
  const [meta, setMeta] = useState<Meta>(DEFAULT_META);
  const [agents, setAgents] = useState<AgentSettings>(DEFAULT_AGENTS);
  const [gateway, setGateway] = useState<GatewaySettings>(DEFAULT_GATEWAY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSettings().then((data: unknown) => {
      const d = data as Record<string, unknown>;
      if (d.meta) setMeta(d.meta as Meta);
      if (d.agents) {
        const ag = d.agents as Record<string, unknown>;
        setAgents({ maxIterations: (ag.maxIterations as number) ?? 100, systemPrompt: (ag.systemPrompt as string) ?? '' });
      }
      if (d.gateway) {
        const gw = d.gateway as Record<string, unknown>;
        const origins = Array.isArray(gw.corsOrigins) ? (gw.corsOrigins as string[]).join('\n') : (gw.corsOrigins as string) ?? '';
        setGateway({ enabled: (gw.enabled as boolean) ?? false, port: (gw.port as number) ?? 3001, corsOrigins: origins, rateLimit: (gw.rateLimit as number) ?? 60 });
      }
    }).finally(() => setLoading(false));
  }, []);

  return (
    <main style={{ padding: '24px', maxWidth: '800px', margin: '0 auto', fontFamily: 'Inter, system-ui, sans-serif', color: '#f9fafb', display: 'flex', flexDirection: 'column', gap: '24px' }} aria-label="Admin settings">
      <header>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>Settings</h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>Configure instance, agent behaviour, gateway, and persona.</p>
      </header>
      <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><Spinner /></div>
      ) : (
        <>
          <div role="tabpanel" id="tabpanel-general" aria-labelledby="tab-general" hidden={activeTab !== 'general'}>
            {activeTab === 'general' && <GeneralTab initial={meta} />}
          </div>
          <div role="tabpanel" id="tabpanel-agents" aria-labelledby="tab-agents" hidden={activeTab !== 'agents'}>
            {activeTab === 'agents' && <AgentsTab initial={agents} />}
          </div>
          <div role="tabpanel" id="tabpanel-gateway" aria-labelledby="tab-gateway" hidden={activeTab !== 'gateway'}>
            {activeTab === 'gateway' && <GatewayTab initial={gateway} />}
          </div>
          <div role="tabpanel" id="tabpanel-persona" aria-labelledby="tab-persona" hidden={activeTab !== 'persona'}>
            {activeTab === 'persona' && <PersonaTab />}
          </div>
        </>
      )}
    </main>
  );
}

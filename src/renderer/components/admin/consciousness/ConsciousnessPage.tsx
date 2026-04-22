import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Tabs } from '@renderer/components/common/Tabs.js';
import { StatusDot } from '@renderer/components/common/StatusDot.js';
import { MetricGauge } from '@renderer/components/common/MetricGauge.js';
import { DataTable } from '@renderer/components/common/DataTable.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConsciousnessModule { name: string; enabled: boolean; healthy: boolean; lastUpdate: string }
interface Thought { id: string; content: string; tier: string; created_at: string }
interface Emotion { timestamp: string; valence: number; arousal: number; dominance: number }
interface BodyState { energy: number; clarity: number; fullness: number; connectivity: number; continuity: number }
interface Episode { id: string; description: string; emotional_weight: number; created_at: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return iso; }
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function bodyColor(v: number): string {
  if (v >= 60) return '#22c55e';
  if (v >= 30) return '#eab308';
  return '#ef4444';
}

const TIER_STYLE: Record<string, React.CSSProperties> = {
  micro:  { backgroundColor: '#1f2937', color: '#9ca3af' },
  medium: { backgroundColor: '#1e3a5f', color: '#60a5fa' },
  deep:   { backgroundColor: '#2d1b4e', color: '#c084fc' },
};

function TierBadge({ tier }: { tier: string }) {
  const style = TIER_STYLE[tier] ?? TIER_STYLE['micro'];
  return (
    <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '999px', fontWeight: 600, ...style }}>
      {tier}
    </span>
  );
}

// ─── Sub-tabs ─────────────────────────────────────────────────────────────────

function OverviewTab() {
  const [modules, setModules] = useState<ConsciousnessModule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchConsciousnessModules().then((d) => { setModules(d as ConsciousnessModule[]); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;

  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
        {modules.map((mod) => (
          <article key={mod.name} style={{ backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '10px', padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <StatusDot status={mod.healthy ? 'online' : 'error'} pulse={mod.healthy} />
              <span style={{ fontSize: '11px', color: mod.enabled ? '#22c55e' : '#6b7280' }}>{mod.enabled ? 'on' : 'off'}</span>
            </div>
            <h4 style={{ margin: '0 0 4px', fontSize: '13px', fontWeight: 600, color: '#f9fafb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mod.name}</h4>
            <p style={{ margin: 0, fontSize: '11px', color: '#6b7280' }}>Updated {fmtTime(mod.lastUpdate)}</p>
          </article>
        ))}
        {modules.length === 0 && <p style={{ color: '#6b7280', fontSize: '14px' }}>No modules found.</p>}
      </div>
    </div>
  );
}

function ThoughtsTab() {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    api.fetchThoughts(50).then((d) => { setThoughts(d as Thought[]); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 5000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refresh]);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;

  return (
    <div style={{ padding: '20px 0' }} aria-live="polite" aria-label="Live thought stream">
      <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#6b7280' }}>Auto-refreshing every 5 seconds — {thoughts.length} thoughts</p>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {thoughts.map((t) => (
          <li key={t.id} style={{ backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '8px', padding: '12px 14px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
            <TierBadge tier={t.tier} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#e5e7eb', lineHeight: 1.5, wordBreak: 'break-word' }}>{t.content}</p>
            </div>
            <time dateTime={t.created_at} style={{ fontSize: '11px', color: '#6b7280', flexShrink: 0, paddingTop: '2px' }}>{fmtTime(t.created_at)}</time>
          </li>
        ))}
        {thoughts.length === 0 && <li style={{ color: '#6b7280', fontSize: '14px', textAlign: 'center', padding: '40px 0' }}>No thoughts yet.</li>}
      </ol>
    </div>
  );
}

function EmotionsTab() {
  const [emotions, setEmotions] = useState<Emotion | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchEmotions().then((d) => { const arr = d as Emotion[]; setEmotions(arr[0] ?? null); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;
  if (!emotions) return <p style={{ color: '#6b7280', fontSize: '14px', padding: '40px 0' }}>No emotion data available.</p>;

  // Normalize -100..100 → 0..100 for gauge
  const norm = (v: number) => Math.round((v + 100) / 2);

  return (
    <div style={{ padding: '20px 0' }}>
      <p style={{ margin: '0 0 24px', fontSize: '12px', color: '#6b7280' }}>Scale: -100 to +100, gauge centered at 0</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '32px', alignItems: 'flex-start' }}>
        {(['valence', 'arousal', 'dominance'] as const).map((key) => (
          <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <MetricGauge value={norm(emotions[key])} label={key.charAt(0).toUpperCase() + key.slice(1)} size={100} color="#3b82f6" />
            <span style={{ fontSize: '13px', color: '#9ca3af' }}>{emotions[key] > 0 ? '+' : ''}{emotions[key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BodyTab() {
  const [body, setBody] = useState<BodyState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchBodyState().then((d) => { setBody(d as BodyState); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;
  if (!body) return <p style={{ color: '#6b7280', fontSize: '14px', padding: '40px 0' }}>No body state data available.</p>;

  const fields: Array<keyof BodyState> = ['energy', 'clarity', 'fullness', 'connectivity', 'continuity'];

  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '32px', alignItems: 'flex-start' }}>
        {fields.map((key) => {
          const val = Math.round(body[key]);
          return (
            <MetricGauge
              key={key}
              value={val}
              label={key.charAt(0).toUpperCase() + key.slice(1)}
              size={100}
              color={bodyColor(val)}
            />
          );
        })}
      </div>
    </div>
  );
}

function EpisodesTab() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchEpisodes(20).then((d) => { setEpisodes((d as Episode[]).slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}><Spinner size="md" /></div>;

  return (
    <div style={{ padding: '20px 0' }}>
      <DataTable<Record<string, unknown>>
        columns={[
          { key: 'description', header: 'Description', width: '55%' },
          { key: 'emotional_weight', header: 'Weight', sortable: true, width: '15%', render: (row) => <span style={{ color: Number(row['emotional_weight']) >= 0.5 ? '#c084fc' : '#9ca3af' }}>{Number(row['emotional_weight']).toFixed(2)}</span> },
          { key: 'created_at', header: 'Time', width: '30%', render: (row) => fmtDate(String(row['created_at'])) },
        ]}
        data={episodes as unknown as Record<string, unknown>[]}
        keyField="id"
        emptyMessage="No episodes recorded."
      />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',  label: 'Overview'  },
  { id: 'thoughts',  label: 'Thoughts'  },
  { id: 'emotions',  label: 'Emotions'  },
  { id: 'body',      label: 'Body'      },
  { id: 'episodes',  label: 'Episodes'  },
];

export function ConsciousnessPage() {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <main style={{ padding: '24px', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#0a0e1a', minHeight: '100%' }}>
      <header style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>Consciousness</h1>
        <p style={{ margin: 0, fontSize: '13px', color: '#6b7280' }}>Internal state, thoughts, emotions, and episodic memory</p>
      </header>

      <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

      <section id={`tabpanel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'overview'  && <OverviewTab />}
        {activeTab === 'thoughts'  && <ThoughtsTab />}
        {activeTab === 'emotions'  && <EmotionsTab />}
        {activeTab === 'body'      && <BodyTab />}
        {activeTab === 'episodes'  && <EpisodesTab />}
      </section>
    </main>
  );
}

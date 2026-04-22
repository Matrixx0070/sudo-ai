import React, { useEffect, useState, useCallback } from 'react';
import { Card } from '@renderer/components/common/Card.js';
import { StatusDot } from '@renderer/components/common/StatusDot.js';
import { Toggle } from '@renderer/components/common/Toggle.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Channel {
  type: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  config: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function channelStatus(ch: Channel): 'online' | 'warning' | 'offline' {
  if (!ch.enabled) return 'offline';
  if (ch.connected) return 'online';
  return 'warning';
}

function channelStatusLabel(ch: Channel): string {
  if (!ch.enabled) return 'Disabled';
  if (ch.connected) return 'Connected';
  return 'Not connected';
}

// ─── ChannelCard ─────────────────────────────────────────────────────────────

interface ChannelCardProps {
  channel: Channel;
  onToggle: (type: string, enabled: boolean) => void;
  onUpdate: (type: string, cfg: Record<string, unknown>) => void;
  onTest: (type: string) => void;
  toggling: boolean;
  testing: boolean;
  testResult: string | null;
}

function ChannelCard({ channel, onToggle, onUpdate, onTest, toggling, testing, testResult }: ChannelCardProps) {
  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(channel.config ?? {});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const status = channelStatus(channel);
  const tokenKey = (channel.config?.tokenEnv as string) ?? `${channel.type.toUpperCase()}_TOKEN`;
  const allowedCount = Array.isArray(channel.config?.allowedUsers)
    ? (channel.config.allowedUsers as unknown[]).length
    : (channel.config?.allowedUsers as number) ?? 0;

  async function handleSave() {
    setSaving(true);
    try {
      await onUpdate(channel.type, draft);
      setSaveMsg('Saved');
    } catch {
      setSaveMsg('Error saving');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 2500);
    }
  }

  return (
    <Card
      style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}
      footer={
        configOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <p style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Configuration
            </p>
            {Object.entries(draft).map(([k, v]) => (
              <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '12px', color: '#9ca3af' }}>{k}</span>
                <input
                  type={k.toLowerCase().includes('token') || k.toLowerCase().includes('key') ? 'password' : 'text'}
                  value={String(v ?? '')}
                  onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                  aria-label={k}
                  style={{
                    padding: '6px 10px', fontSize: '13px', color: '#f9fafb',
                    backgroundColor: '#0a0e1a', border: '1px solid #1f2937',
                    borderRadius: '6px', outline: 'none', fontFamily: 'Inter, system-ui, sans-serif',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = '#3b82f6'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = '#1f2937'; }}
                />
              </label>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
              <button
                onClick={handleSave}
                disabled={saving}
                aria-label="Save configuration"
                style={{
                  padding: '6px 14px', fontSize: '12px', fontWeight: 600,
                  backgroundColor: '#3b82f6', color: '#fff', border: 'none',
                  borderRadius: '6px', cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {saveMsg && <span style={{ fontSize: '12px', color: saveMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{saveMsg}</span>}
            </div>
          </div>
        ) : undefined
      }
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div
          aria-hidden="true"
          style={{
            width: '40px', height: '40px', borderRadius: '10px',
            backgroundColor: '#1f2937', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '18px', fontWeight: 700,
            color: '#3b82f6', flexShrink: 0, textTransform: 'uppercase',
          }}
        >
          {channel.name.charAt(0)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#f9fafb' }}>{channel.name}</p>
          <StatusDot status={status} label={channelStatusLabel(channel)} />
        </div>
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
          <span style={{ color: '#9ca3af' }}>Token env</span>
          <code style={{ color: '#f9fafb', backgroundColor: '#1f2937', padding: '1px 6px', borderRadius: '4px', fontSize: '11px' }}>
            {tokenKey}
          </code>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
          <span style={{ color: '#9ca3af' }}>Allowed users</span>
          <span style={{ color: '#f9fafb', fontWeight: 600 }}>{allowedCount === 0 ? 'All' : allowedCount}</span>
        </div>
      </div>

      {/* Toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Toggle
          label="Enabled"
          checked={channel.enabled}
          onChange={en => onToggle(channel.type, en)}
          disabled={toggling}
        />
        {toggling && <Spinner size="sm" />}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          onClick={() => setConfigOpen(o => !o)}
          aria-expanded={configOpen}
          aria-controls={`config-${channel.type}`}
          style={btnStyle('#1f2937', '#374151')}
        >
          {configOpen ? 'Close' : 'Configure'}
        </button>
        {channel.enabled && (
          <button
            onClick={() => onTest(channel.type)}
            disabled={testing}
            aria-label={`Test ${channel.name} connection`}
            style={btnStyle('#1d4ed8', '#2563eb')}
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
        )}
        {testResult && (
          <span style={{ fontSize: '12px', alignSelf: 'center', color: testResult.startsWith('Error') ? '#ef4444' : '#22c55e' }}>
            {testResult}
          </span>
        )}
      </div>
    </Card>
  );
}

function btnStyle(bg: string, hover: string): React.CSSProperties {
  return {
    padding: '6px 12px', fontSize: '12px', fontWeight: 600,
    backgroundColor: bg, color: '#f9fafb', border: 'none',
    borderRadius: '6px', cursor: 'pointer',
    transition: 'background-color 150ms ease',
  };
}

// ─── ChannelsPage ─────────────────────────────────────────────────────────────

export function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.fetchChannels();
      setChannels(data as Channel[]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load channels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(type: string, enabled: boolean) {
    setTogglingId(type);
    try {
      await api.toggleChannel(type, enabled);
      setChannels(cs => cs.map(c => c.type === type ? { ...c, enabled } : c));
    } catch {
      // revert handled by not mutating
    } finally {
      setTogglingId(null);
    }
  }

  async function handleUpdate(type: string, cfg: Record<string, unknown>) {
    await api.updateChannel(type, cfg);
  }

  async function handleTest(type: string) {
    setTestingId(type);
    try {
      await (api as unknown as Record<string, (t: string, m: string) => Promise<unknown>>).testChannel(type, 'ping');
      setTestResults(r => ({ ...r, [type]: 'OK' }));
    } catch (e: unknown) {
      setTestResults(r => ({ ...r, [type]: e instanceof Error ? `Error: ${e.message}` : 'Error' }));
    } finally {
      setTestingId(null);
      setTimeout(() => setTestResults(r => { const n = { ...r }; delete n[type]; return n; }), 3000);
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '60px' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '24px', color: '#ef4444', fontSize: '14px' }}>
        {error} — <button onClick={load} style={{ color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
      </div>
    );
  }

  return (
    <main style={{ padding: '24px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>Channels</h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>
          Manage messaging integrations — {channels.length} channel{channels.length !== 1 ? 's' : ''} configured
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '16px',
        }}
        role="list"
        aria-label="Channel list"
      >
        {channels.map(ch => (
          <div key={ch.type} role="listitem">
            <ChannelCard
              channel={ch}
              onToggle={handleToggle}
              onUpdate={handleUpdate}
              onTest={handleTest}
              toggling={togglingId === ch.type}
              testing={testingId === ch.type}
              testResult={testResults[ch.type] ?? null}
            />
          </div>
        ))}
        {channels.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: '14px' }}>No channels configured.</p>
        )}
      </div>
    </main>
  );
}

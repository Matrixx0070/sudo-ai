import React, { useEffect, useState, useCallback } from 'react';
import { DataTable } from '@renderer/components/common/DataTable.js';
import { SearchInput } from '@renderer/components/common/SearchInput.js';
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import { Card } from '@renderer/components/common/Card.js';
import * as api from '@renderer/lib/admin-api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  channel: string;
  peerId: string;
  state: string;
  messageCount: number;
  createdAt: string;
}

interface Message {
  role: 'user' | 'assistant' | string;
  content: string;
  timestamp?: string;
}

interface SessionDetail {
  id: string;
  channel: string;
  peerId: string;
  state: string;
  createdAt: string;
  messages: Message[];
}

type StateFilter = 'all' | 'active' | 'closed';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function truncateId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

// ─── StateBadge ───────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  const active = state === 'active';
  return (
    <span
      style={{
        display: 'inline-block', padding: '2px 8px',
        fontSize: '11px', fontWeight: 700, borderRadius: '999px',
        backgroundColor: active ? 'rgba(59,130,246,0.15)' : 'rgba(107,114,128,0.15)',
        color: active ? '#60a5fa' : '#9ca3af',
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}
    >
      {state}
    </span>
  );
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '10px',
      }}
    >
      <div
        style={{
          maxWidth: '72%', padding: '8px 12px', borderRadius: '10px',
          fontSize: '13px', lineHeight: 1.5,
          backgroundColor: isUser ? '#1d4ed8' : '#1f2937',
          color: '#f9fafb',
          borderTopRightRadius: isUser ? '2px' : '10px',
          borderTopLeftRadius: isUser ? '10px' : '2px',
        }}
      >
        <p style={{ margin: 0, wordBreak: 'break-word' }}>{msg.content}</p>
        {msg.timestamp && (
          <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'rgba(255,255,255,0.45)', textAlign: isUser ? 'right' : 'left' }}>
            {formatDate(msg.timestamp)}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── SessionDetail ────────────────────────────────────────────────────────────

interface DetailPanelProps {
  sessionId: string;
  onClose: () => void;
  onDelete: (id: string) => void;
}

function DetailPanel({ sessionId, onClose, onDelete }: DetailPanelProps) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    api.fetchSession(sessionId)
      .then(d => { if (!cancelled) { setDetail(d as SessionDetail); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Load failed'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [sessionId]);

  return (
    <section
      aria-label="Session detail"
      style={{ marginTop: '20px', backgroundColor: '#111827', border: '1px solid #1f2937', borderRadius: '10px', overflow: 'hidden' }}
    >
      {/* Detail header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #1f2937' }}>
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#f9fafb' }}>
          Session: <code style={{ fontSize: '12px', color: '#9ca3af' }}>{truncateId(sessionId, 16)}</code>
        </h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setConfirmDelete(true)}
            aria-label="Delete session"
            style={{ padding: '5px 12px', fontSize: '12px', fontWeight: 600, backgroundColor: '#7f1d1d', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
            Delete
          </button>
          <button onClick={onClose} aria-label="Close detail panel"
            style={{ padding: '5px 12px', fontSize: '12px', fontWeight: 600, backgroundColor: '#1f2937', color: '#f9fafb', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
            Close
          </button>
        </div>
      </div>

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}><Spinner size="md" /></div>}
      {error && <p style={{ padding: '20px', color: '#ef4444', fontSize: '13px' }}>{error}</p>}

      {detail && !loading && (
        <>
          {/* Meta info */}
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', padding: '14px 20px', borderBottom: '1px solid #1f2937' }}>
            {[
              ['Channel', detail.channel],
              ['Peer ID', detail.peerId],
              ['State', <StateBadge key="s" state={detail.state} />],
              ['Created', formatDate(detail.createdAt)],
              ['Messages', detail.messages.length],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <p style={{ margin: 0, fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
                <p style={{ margin: '2px 0 0', fontSize: '13px', fontWeight: 600, color: '#f9fafb' }}>{value as React.ReactNode}</p>
              </div>
            ))}
          </div>

          {/* Chat area */}
          <div
            role="log"
            aria-label="Conversation messages"
            aria-live="polite"
            style={{ padding: '16px 20px', maxHeight: '400px', overflowY: 'auto' }}
          >
            {detail.messages.length === 0 && (
              <p style={{ color: '#9ca3af', fontSize: '13px', textAlign: 'center' }}>No messages in this session.</p>
            )}
            {detail.messages.map((msg, i) => (
              <MessageBubble key={i} msg={msg} />
            ))}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete Session"
        message="This session and all its messages will be permanently removed."
        confirmLabel="Delete"
        danger
        onConfirm={() => { setConfirmDelete(false); onDelete(sessionId); }}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

// ─── SessionsPage ─────────────────────────────────────────────────────────────

export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const filter = stateFilter === 'all' ? undefined : stateFilter;
      setSessions((await api.fetchSessions(filter, 100)) as Session[]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, [stateFilter]);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string) {
    await api.deleteSession(id);
    setSessions(ss => ss.filter(s => s.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  const filtered = sessions.filter(s =>
    s.id.toLowerCase().includes(search.toLowerCase()) ||
    s.channel.toLowerCase().includes(search.toLowerCase()) ||
    s.peerId.toLowerCase().includes(search.toLowerCase())
  );

  const columns = [
    { key: 'id', header: 'ID', width: '14%', render: (r: Session) => <code style={{ fontSize: '11px', color: '#9ca3af' }}>{truncateId(r.id)}</code> },
    { key: 'channel', header: 'Channel', sortable: true, width: '12%' },
    { key: 'peerId', header: 'Peer ID', width: '16%', render: (r: Session) => <span style={{ fontSize: '12px' }}>{r.peerId}</span> },
    { key: 'messageCount', header: 'Messages', sortable: true, width: '10%', render: (r: Session) => <span style={{ fontWeight: 600 }}>{r.messageCount}</span> },
    { key: 'createdAt', header: 'Created', sortable: true, width: '18%', render: (r: Session) => <span style={{ fontSize: '12px', color: '#9ca3af' }}>{formatDate(r.createdAt)}</span> },
    { key: 'state', header: 'Status', width: '10%', render: (r: Session) => <StateBadge state={r.state} /> },
    {
      key: 'view', header: '', width: '10%',
      render: (r: Session) => (
        <button
          onClick={e => { e.stopPropagation(); setSelectedId(id => id === r.id ? null : r.id); }}
          aria-label={`${selectedId === r.id ? 'Close' : 'View'} session ${truncateId(r.id)}`}
          style={{ padding: '3px 10px', fontSize: '11px', fontWeight: 600, backgroundColor: selectedId === r.id ? '#374151' : '#1d4ed8', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          {selectedId === r.id ? 'Close' : 'View'}
        </button>
      ),
    },
  ];

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '60px' }}><Spinner size="lg" /></div>;
  if (error) return <div style={{ padding: '24px', color: '#ef4444', fontSize: '14px' }}>{error} — <button onClick={load} style={{ color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button></div>;

  return (
    <main style={{ padding: '24px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <header style={{ marginBottom: '20px' }}>
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>Sessions</h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>{sessions.length} session{sessions.length !== 1 ? 's' : ''} total</p>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', maxWidth: '360px' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search by ID, channel, peer…" />
        </div>
        <label htmlFor="state-filter" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#9ca3af' }}>
          State
          <select
            id="state-filter"
            value={stateFilter}
            onChange={e => { setStateFilter(e.target.value as StateFilter); setSelectedId(null); }}
            style={{
              padding: '7px 10px', fontSize: '13px', color: '#f9fafb',
              backgroundColor: '#111827', border: '1px solid #1f2937',
              borderRadius: '6px', outline: 'none', cursor: 'pointer',
              fontFamily: 'Inter, system-ui, sans-serif',
            }}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      </div>

      <DataTable
        columns={columns as Parameters<typeof DataTable>[0]['columns']}
        data={filtered as unknown as Record<string, unknown>[]}
        keyField="id"
        emptyMessage="No sessions found."
        onRowClick={row => setSelectedId(id => id === String(row['id']) ? null : String(row['id']))}
      />

      {selectedId && (
        <DetailPanel
          sessionId={selectedId}
          onClose={() => setSelectedId(null)}
          onDelete={handleDelete}
        />
      )}
    </main>
  );
}

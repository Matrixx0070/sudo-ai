import React, { useEffect, useRef, useState, useCallback } from 'react';
import { SearchInput } from '@renderer/components/common/SearchInput.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';

// ─── types ────────────────────────────────────────────────────────────────────

type LogLevel = 'all' | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  timestamp: string;
  level: string;
  module?: string;
  msg: string;
}

// ─── constants ────────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  trace: '#6b7280',
  debug: '#3b82f6',
  info:  '#22c55e',
  warn:  '#eab308',
  error: '#ef4444',
  fatal: '#a855f7',
};

const LEVEL_BG: Record<string, string> = {
  trace: '#6b728022',
  debug: '#3b82f622',
  info:  '#22c55e22',
  warn:  '#eab30822',
  error: '#ef444422',
  fatal: '#a855f722',
};

const LEVELS: LogLevel[] = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'];

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(raw: string): string {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return raw;
  }
}

// ─── sub-components ───────────────────────────────────────────────────────────

function LevelBadge({ level }: { level: string }) {
  const lower = level.toLowerCase();
  const color = LEVEL_COLORS[lower] ?? '#9ca3af';
  const bg = LEVEL_BG[lower] ?? '#9ca3af22';
  return (
    <span
      aria-label={`Log level: ${lower}`}
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: '4px',
        fontSize: '11px',
        fontWeight: 700,
        fontFamily: 'monospace',
        color,
        backgroundColor: bg,
        border: `1px solid ${color}55`,
        minWidth: '44px',
        textAlign: 'center',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {lower}
    </span>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<LogLevel>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadLogs = useCallback(async () => {
    try {
      const res = await api.fetchLogs(
        level !== 'all' ? level : undefined,
        search || undefined,
        200,
      );
      const data = res as { entries?: LogEntry[] } | LogEntry[];
      const raw: LogEntry[] = Array.isArray(data)
        ? (data as LogEntry[])
        : ((data as { entries?: LogEntry[] }).entries ?? []);
      setEntries(raw);
    } catch {
      // retain previous entries on failure
    } finally {
      setLoading(false);
    }
  }, [level, search]);

  // Initial load + reload when filters change
  useEffect(() => {
    setLoading(true);
    void loadLogs();
  }, [loadLogs]);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => { void loadLogs(); }, 5_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, loadLogs]);

  function handleManualRefresh() {
    setLoading(true);
    void loadLogs();
  }

  return (
    <main
      aria-label="Log Viewer"
      style={{
        padding: '24px',
        backgroundColor: '#0a0e1a',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      {/* Page header */}
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
          Logs
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>
          Real-time system log viewer
        </p>
      </header>

      {/* Controls bar */}
      <div
        role="toolbar"
        aria-label="Log filters"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px',
          alignItems: 'center',
        }}
      >
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search logs…"
            debounceMs={400}
          />
        </div>

        {/* Level selector */}
        <label
          htmlFor="log-level-select"
          style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}
        >
          <span style={{ fontSize: '13px', color: '#9ca3af', whiteSpace: 'nowrap' }}>Level</span>
          <select
            id="log-level-select"
            value={level}
            onChange={(e) => setLevel(e.target.value as LogLevel)}
            style={{
              padding: '7px 10px',
              borderRadius: '6px',
              border: '1px solid #1f2937',
              backgroundColor: '#111827',
              color: '#f9fafb',
              fontSize: '13px',
              fontFamily: 'Inter, system-ui, sans-serif',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l === 'all' ? 'All levels' : l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>

        {/* Auto-refresh toggle */}
        <label
          htmlFor="auto-refresh-toggle"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <input
            id="auto-refresh-toggle"
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            style={{ accentColor: '#3b82f6', width: '15px', height: '15px', cursor: 'pointer' }}
          />
          <span style={{ fontSize: '13px', color: '#9ca3af', whiteSpace: 'nowrap' }}>
            Auto-refresh
          </span>
        </label>

        {/* Manual refresh */}
        <button
          onClick={handleManualRefresh}
          disabled={loading}
          aria-label="Refresh logs now"
          style={{
            padding: '7px 14px',
            borderRadius: '6px',
            border: '1px solid #1f2937',
            backgroundColor: '#111827',
            color: loading ? '#9ca3af' : '#f9fafb',
            fontSize: '13px',
            cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            flexShrink: 0,
            fontFamily: 'Inter, system-ui, sans-serif',
          }}
        >
          {loading ? <Spinner size="sm" /> : <span aria-hidden="true">↻</span>}
          Refresh
        </button>

        <span
          aria-live="polite"
          role="status"
          style={{ fontSize: '12px', color: '#6b7280', flexShrink: 0 }}
        >
          {entries.length} entries
        </span>
      </div>

      {/* Log table */}
      <div
        style={{
          flex: 1,
          border: '1px solid #1f2937',
          borderRadius: '8px',
          overflow: 'hidden',
          backgroundColor: '#0d1117',
        }}
      >
        <div
          style={{
            overflowY: 'auto',
            maxHeight: 'calc(100vh - 280px)',
            minHeight: '320px',
          }}
          role="log"
          aria-label="Log entries"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions"
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              tableLayout: 'fixed',
            }}
            aria-label="System logs"
          >
            <thead>
              <tr style={{ backgroundColor: '#0f1628', position: 'sticky', top: 0, zIndex: 1 }}>
                <th
                  scope="col"
                  style={{
                    width: '90px',
                    padding: '8px 12px',
                    textAlign: 'left',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#6b7280',
                    borderBottom: '1px solid #1f2937',
                    fontFamily: 'monospace',
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                >
                  Time
                </th>
                <th
                  scope="col"
                  style={{
                    width: '70px',
                    padding: '8px 12px',
                    textAlign: 'left',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#6b7280',
                    borderBottom: '1px solid #1f2937',
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                >
                  Level
                </th>
                <th
                  scope="col"
                  style={{
                    width: '120px',
                    padding: '8px 12px',
                    textAlign: 'left',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#6b7280',
                    borderBottom: '1px solid #1f2937',
                    fontFamily: 'monospace',
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                >
                  Module
                </th>
                <th
                  scope="col"
                  style={{
                    padding: '8px 12px',
                    textAlign: 'left',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#6b7280',
                    borderBottom: '1px solid #1f2937',
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                >
                  Message
                </th>
              </tr>
            </thead>
            <tbody ref={tableBodyRef}>
              {loading && entries.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: '40px', textAlign: 'center' }}>
                    <Spinner size="lg" />
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    style={{
                      padding: '40px',
                      textAlign: 'center',
                      color: '#6b7280',
                      fontSize: '13px',
                    }}
                  >
                    No log entries found.
                  </td>
                </tr>
              ) : (
                entries.map((entry, i) => {
                  const lower = (entry.level ?? '').toLowerCase();
                  const rowBg = i % 2 === 0 ? '#0d1117' : '#0a0e1a';
                  return (
                    <tr
                      key={i}
                      style={{ backgroundColor: rowBg }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.backgroundColor = '#131928';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.backgroundColor = rowBg;
                      }}
                    >
                      <td
                        style={{
                          padding: '6px 12px',
                          fontFamily: 'monospace',
                          fontSize: '12px',
                          color: '#6b7280',
                          borderBottom: '1px solid #1a2030',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td
                        style={{
                          padding: '6px 12px',
                          borderBottom: '1px solid #1a2030',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <LevelBadge level={lower} />
                      </td>
                      <td
                        style={{
                          padding: '6px 12px',
                          fontFamily: 'monospace',
                          fontSize: '12px',
                          color: '#3b82f6',
                          borderBottom: '1px solid #1a2030',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {entry.module ?? '—'}
                      </td>
                      <td
                        style={{
                          padding: '6px 12px',
                          fontFamily: 'monospace',
                          fontSize: '12px',
                          color: '#e2e8f0',
                          borderBottom: '1px solid #1a2030',
                          wordBreak: 'break-word',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {entry.msg}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

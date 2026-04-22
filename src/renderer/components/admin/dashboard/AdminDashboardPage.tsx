import React, { useEffect, useState, useCallback } from 'react';
import { Card } from '@renderer/components/common/Card.js';
import { MetricGauge } from '@renderer/components/common/MetricGauge.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';
import type { DashboardStats } from '@renderer/lib/admin-api.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// ─── sub-components ───────────────────────────────────────────────────────────

interface InfoRowProps {
  label: string;
  value: React.ReactNode;
}

function InfoRow({ label, value }: InfoRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 0',
        borderBottom: '1px solid #1f2937',
      }}
    >
      <span style={{ fontSize: '13px', color: '#9ca3af' }}>{label}</span>
      <span style={{ fontSize: '13px', fontWeight: 600, color: '#f9fafb' }}>
        {value}
      </span>
    </div>
  );
}

interface ActionButtonProps {
  label: string;
  color: string;
  hoverColor: string;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

function ActionButton({ label, color, hoverColor, onClick, disabled, ariaLabel }: ActionButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      style={{
        padding: '10px 20px',
        borderRadius: '8px',
        border: 'none',
        backgroundColor: hovered ? hoverColor : color,
        color: '#ffffff',
        fontSize: '13px',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background-color 150ms ease, opacity 150ms ease',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {label}
    </button>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function AdminDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      const data = await api.fetchDashboardStats();
      setStats(data);
    } catch {
      // silently retain previous data on poll failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats();
    const id = setInterval(() => { void loadStats(); }, 10_000);
    return () => clearInterval(id);
  }, [loadStats]);

  async function handleRestart() {
    setActionPending(true);
    setActionMsg(null);
    try {
      const res = await api.restartService();
      setActionMsg(res.success ? 'Service restarted successfully.' : 'Restart failed.');
    } catch (e) {
      setActionMsg(`Error: ${String(e)}`);
    } finally {
      setActionPending(false);
    }
  }

  async function handleStop() {
    if (!confirmStop) {
      setConfirmStop(true);
      setTimeout(() => setConfirmStop(false), 5000);
      return;
    }
    setConfirmStop(false);
    setActionPending(true);
    setActionMsg(null);
    try {
      const res = await api.stopService();
      setActionMsg(res.success ? 'Service stopped.' : 'Stop failed.');
    } catch (e) {
      setActionMsg(`Error: ${String(e)}`);
    } finally {
      setActionPending(false);
    }
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '240px',
        }}
      >
        <Spinner size="lg" />
      </div>
    );
  }

  const s = stats as Record<string, unknown> | null;
  const cpu = Number(s?.cpu ?? s?.cpuPercent ?? 0);
  const mem = Number(s?.memory ?? s?.memoryPercent ?? 0);
  const disk = Number(s?.disk ?? s?.diskPercent ?? 0);
  const uptime = Number(s?.uptime ?? 0);
  const requests = Number(s?.totalRequests ?? s?.activeSessions ?? 0);
  const channels = Number(s?.activeChannels ?? 0);
  const tools = Number(s?.enabledTools ?? 0);
  const consciousness = Number(s?.consciousnessScore ?? 0);

  return (
    <main
      aria-label="Admin Dashboard"
      style={{
        padding: '24px',
        backgroundColor: '#0a0e1a',
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
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
          Dashboard
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#9ca3af' }}>
          System health and activity overview
        </p>
      </header>

      {/* Row 1: Metric Gauges */}
      <section
        aria-label="System metrics"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '16px',
        }}
      >
        <Card title="CPU Usage">
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
            <MetricGauge value={cpu} label="CPU" size={100} />
          </div>
        </Card>

        <Card title="Memory Usage">
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
            <MetricGauge value={mem} label="Memory" size={100} />
          </div>
        </Card>

        <Card title="Disk Usage">
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
            <MetricGauge value={disk} label="Disk" size={100} />
          </div>
        </Card>
      </section>

      {/* Row 2: Info Cards */}
      <section
        aria-label="Activity statistics"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
        }}
      >
        <Card title="Uptime" icon={<span aria-hidden="true">⏱</span>}>
          <div style={{ fontSize: '28px', fontWeight: 700, color: '#3b82f6' }}>
            {formatUptime(uptime)}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#9ca3af' }}>
            Continuous runtime
          </p>
        </Card>

        <Card title="Requests" icon={<span aria-hidden="true">📊</span>}>
          <InfoRow label="Total requests" value={requests.toLocaleString()} />
          <InfoRow label="Active channels" value={channels} />
        </Card>

        <Card title="Capabilities" icon={<span aria-hidden="true">🔧</span>}>
          <InfoRow label="Tools enabled" value={tools} />
          <InfoRow
            label="Consciousness"
            value={
              <span style={{ color: '#3b82f6' }}>{consciousness}%</span>
            }
          />
        </Card>
      </section>

      {/* Row 3: Quick Actions */}
      <section aria-label="Quick actions">
        <Card title="Quick Actions" subtitle="Manage service lifecycle">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px',
              alignItems: 'center',
            }}
          >
            <ActionButton
              label="Restart Service"
              color="#3b82f6"
              hoverColor="#2563eb"
              onClick={() => { void handleRestart(); }}
              disabled={actionPending}
            />

            <ActionButton
              label={confirmStop ? 'Click again to confirm stop' : 'Stop Service'}
              color={confirmStop ? '#b91c1c' : '#dc2626'}
              hoverColor="#991b1b"
              onClick={() => { void handleStop(); }}
              disabled={actionPending}
              ariaLabel={confirmStop ? 'Confirm stop service' : 'Stop service'}
            />

            {actionPending && <Spinner size="sm" />}

            {actionMsg && (
              <span
                role="status"
                aria-live="polite"
                style={{ fontSize: '13px', color: '#9ca3af', marginLeft: '4px' }}
              >
                {actionMsg}
              </span>
            )}
          </div>
        </Card>
      </section>
    </main>
  );
}

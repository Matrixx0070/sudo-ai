import React, { useEffect } from 'react';
import { useDashboardStore } from '@renderer/stores/dashboardStore';
import { useIpcInvoke, useIpcOn } from '@renderer/hooks/useIpc';

function Gauge({ label, value }: { label: string; value: number }) {
  const color =
    value > 85
      ? 'var(--accent-red)'
      : value > 65
      ? 'var(--accent-yellow)'
      : 'var(--accent-green)';

  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width="100" height="100" viewBox="0 0 100 100" aria-label={`${label}: ${value}%`}>
        {/* Background ring */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth="8"
        />
        {/* Progress ring */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 0.7s ease' }}
        />
        <text
          x="50"
          y="54"
          textAnchor="middle"
          fill="var(--text-primary)"
          fontSize="16"
          fontWeight="700"
          fontFamily="Inter, sans-serif"
        >
          {value}%
        </text>
      </svg>
      <span className="text-xs font-medium text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}

export function SystemView() {
  const { systemMetrics, setSystemMetrics } = useDashboardStore();
  const getMetrics = useIpcInvoke('system:metrics');

  useEffect(() => {
    getMetrics().then((data) => {
      if (data) setSystemMetrics(data as typeof systemMetrics);
    });
  }, []);

  useIpcOn('system:metrics', (...args) => {
    const data = args[0];
    if (data) setSystemMetrics(data as typeof systemMetrics);
  });

  const uptimeH = Math.floor(systemMetrics.uptime / 3600);
  const uptimeM = Math.floor((systemMetrics.uptime % 3600) / 60);
  const uptimeS = Math.floor(systemMetrics.uptime % 60);

  return (
    <div className="h-full overflow-y-auto p-5 space-y-5">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">System Monitor</h1>

      {/* Gauges */}
      <section
        aria-label="Resource usage"
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6"
      >
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-6">Resource Usage</h2>
        <div className="flex items-center justify-around flex-wrap gap-6">
          <Gauge label="CPU" value={systemMetrics.cpuPercent} />
          <Gauge label="Memory" value={systemMetrics.memoryPercent} />
          <Gauge label="Disk" value={systemMetrics.diskPercent} />
        </div>
      </section>

      {/* Info grid */}
      <section
        aria-label="System information"
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4"
      >
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">System Info</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {(
            [
              { dt: 'Uptime', dd: `${uptimeH}h ${uptimeM}m ${uptimeS}s` },
              { dt: 'Platform', dd: typeof process !== 'undefined' ? process.platform : 'electron' },
            ] as const
          ).map(({ dt, dd }) => (
            <div key={dt} className="bg-[var(--bg-secondary)] rounded-lg p-3">
              <dt className="text-xs text-[var(--text-secondary)] mb-0.5">{dt}</dt>
              <dd className="text-[var(--text-primary)] font-medium font-mono text-xs">{dd}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

import React, { useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useDashboardStore } from '@renderer/stores/dashboardStore';
import { useIpcOn, useIpcInvoke } from '@renderer/hooks/useIpc';
import { MetricCard } from './MetricCard';
import { Badge } from '@renderer/components/common/Badge';

function IconEye() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconDollar() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2v12M5 4.5h4.5a2 2 0 010 4H6a2 2 0 000 4H11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconVideo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="3" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M11 6l4-2v8l-4-2V6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconHeart() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 13S2 9.5 2 5.5a3.5 3.5 0 017-0 3.5 3.5 0 017 0C16 9.5 10 13 8 13z" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function DashboardView() {
  const {
    totalViews, viewsChange,
    revenue, revenueChange,
    videosProduced, videosChange,
    systemHealth,
    revenueHistory,
    recentActivity,
    cronJobs,
    systemMetrics,
    setSystemMetrics,
  } = useDashboardStore();

  const getMetrics = useIpcInvoke('system:metrics');
  const getCrons = useIpcInvoke('cron:list');

  useEffect(() => {
    getMetrics().then((data) => {
      if (data) {
        const { setSystemMetrics: setter } = useDashboardStore.getState();
        setter(data as Parameters<typeof setter>[0]);
      }
    });
    getCrons().then((data) => {
      if (data) {
        const { setCronJobs } = useDashboardStore.getState();
        setCronJobs(data as Parameters<typeof setCronJobs>[0]);
      }
    });
  }, []);

  useIpcOn('system:metrics', (...args) => {
    const data = args[0];
    if (data) {
      useDashboardStore.getState().setSystemMetrics(data as Parameters<typeof setSystemMetrics>[0]);
    }
  });

  return (
    <div className="h-full overflow-y-auto p-5 space-y-5">
      {/* Metric cards */}
      <section aria-label="Key metrics">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            type="views"
            title="Total Views"
            value={totalViews}
            change={viewsChange}
            icon={<IconEye />}
          />
          <MetricCard
            type="revenue"
            title="Revenue"
            value={`$${revenue.toLocaleString()}`}
            change={revenueChange}
            icon={<IconDollar />}
          />
          <MetricCard
            type="videos"
            title="Videos Produced"
            value={videosProduced}
            change={videosChange}
            icon={<IconVideo />}
          />
          <MetricCard
            type="health"
            title="System Health"
            value={`${systemHealth}%`}
            change={0}
            icon={<IconHeart />}
          />
        </div>
      </section>

      {/* Revenue chart + activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Revenue chart */}
        <section
          aria-label="Revenue chart"
          className="lg:col-span-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4"
        >
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-4">
            Revenue — Last 8 Days
          </h2>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={revenueHistory} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: '#9ca3af', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#9ca3af', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '8px',
                  color: '#f3f4f6',
                  fontSize: 12,
                }}
                cursor={{ stroke: '#374151' }}
              />
              <Line
                type="monotone"
                dataKey="amount"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ fill: '#3b82f6', r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </section>

        {/* Recent activity */}
        <section
          aria-label="Recent activity"
          className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4"
        >
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            Recent Activity
          </h2>
          {recentActivity.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] italic">No activity yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentActivity.slice(0, 8).map((entry) => (
                <li key={entry.id} className="flex items-start gap-2 text-xs">
                  <span className="text-[var(--text-secondary)] flex-shrink-0 pt-0.5">
                    {new Date(entry.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-[var(--text-primary)]">{entry.description}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Cron jobs + System metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active cron jobs */}
        <section
          aria-label="Cron jobs"
          className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4"
        >
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            Active Cron Jobs
          </h2>
          {cronJobs.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)] italic">No cron jobs configured.</p>
          ) : (
            <ul className="space-y-2">
              {cronJobs.map((job) => (
                <li
                  key={job.id}
                  className="flex items-center justify-between text-xs py-1.5 border-b border-[var(--border)] last:border-0"
                >
                  <div>
                    <div className="text-[var(--text-primary)] font-medium">{job.name}</div>
                    <div className="text-[var(--text-secondary)]">{job.schedule}</div>
                  </div>
                  <Badge
                    status={job.status === 'active' ? 'online' : job.status === 'error' ? 'offline' : 'warning'}
                    label={job.status}
                    dot
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* System metrics */}
        <section
          aria-label="System status"
          className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4"
        >
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            System Status
          </h2>
          <div className="space-y-3">
            {(
              [
                { label: 'CPU', value: systemMetrics.cpuPercent },
                { label: 'Memory', value: systemMetrics.memoryPercent },
                { label: 'Disk', value: systemMetrics.diskPercent },
              ] as const
            ).map(({ label, value }) => (
              <div key={label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[var(--text-secondary)]">{label}</span>
                  <span
                    className={
                      value > 85
                        ? 'text-[var(--accent-red)]'
                        : value > 65
                        ? 'text-[var(--accent-yellow)]'
                        : 'text-[var(--accent-green)]'
                    }
                  >
                    {value}%
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={value}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${label} usage`}
                  className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden"
                >
                  <div
                    className={[
                      'h-full rounded-full transition-all duration-700',
                      value > 85
                        ? 'bg-[var(--accent-red)]'
                        : value > 65
                        ? 'bg-[var(--accent-yellow)]'
                        : 'bg-[var(--accent-green)]',
                    ].join(' ')}
                    style={{ width: `${value}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="text-xs text-[var(--text-secondary)] pt-1">
              Uptime:{' '}
              <span className="text-[var(--text-primary)]">
                {Math.floor(systemMetrics.uptime / 3600)}h{' '}
                {Math.floor((systemMetrics.uptime % 3600) / 60)}m
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

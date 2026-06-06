import React from 'react';

type MetricType = 'views' | 'revenue' | 'videos' | 'health';

interface MetricCardProps {
  type: MetricType;
  title: string;
  value: string | number;
  change: number; // positive = up, negative = down
  icon: React.ReactNode;
}

const typeAccent: Record<MetricType, string> = {
  views: 'text-[var(--accent)]',
  revenue: 'text-[var(--accent-green)]',
  videos: 'text-[var(--accent-yellow)]',
  health: 'text-[var(--accent-green)]',
};

const typeBg: Record<MetricType, string> = {
  views: 'bg-blue-900/30',
  revenue: 'bg-emerald-900/30',
  videos: 'bg-yellow-900/30',
  health: 'bg-emerald-900/30',
};

export function MetricCard({ type, title, value, change, icon }: MetricCardProps) {
  const isPositive = change >= 0;
  const changeText = `${isPositive ? '+' : ''}${change}%`;

  return (
    <article
      className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-3"
      aria-label={`${title} metric`}
    >
      {/* Icon + title */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wide">
          {title}
        </span>
        <span
          className={['w-8 h-8 rounded-lg flex items-center justify-center', typeBg[type]].join(' ')}
          aria-hidden="true"
        >
          <span className={typeAccent[type]}>{icon}</span>
        </span>
      </div>

      {/* Value */}
      <div className="text-2xl font-bold text-[var(--text-primary)]">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>

      {/* Change indicator */}
      <div
        className={[
          'flex items-center gap-1 text-xs font-medium',
          isPositive ? 'text-[var(--accent-green)]' : 'text-[var(--accent-red)]',
        ].join(' ')}
        aria-label={`Change: ${changeText}`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className={isPositive ? '' : 'rotate-180'}
        >
          <path d="M6 2l4 6H2l4-6z" fill="currentColor" />
        </svg>
        {changeText} vs last week
      </div>
    </article>
  );
}

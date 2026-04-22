import React from 'react';

type BadgeStatus = 'online' | 'offline' | 'warning' | 'info' | 'neutral';

interface BadgeProps {
  status?: BadgeStatus;
  label: string;
  dot?: boolean;
  className?: string;
}

const statusStyles: Record<BadgeStatus, { dot: string; badge: string }> = {
  online: {
    dot: 'bg-[var(--accent-green)]',
    badge: 'bg-emerald-900/40 text-[var(--accent-green)] border border-emerald-700/50',
  },
  offline: {
    dot: 'bg-[var(--accent-red)]',
    badge: 'bg-red-900/40 text-[var(--accent-red)] border border-red-700/50',
  },
  warning: {
    dot: 'bg-[var(--accent-yellow)]',
    badge: 'bg-yellow-900/40 text-[var(--accent-yellow)] border border-yellow-700/50',
  },
  info: {
    dot: 'bg-[var(--accent)]',
    badge: 'bg-blue-900/40 text-[var(--accent)] border border-blue-700/50',
  },
  neutral: {
    dot: 'bg-[var(--text-secondary)]',
    badge: 'bg-gray-800/40 text-[var(--text-secondary)] border border-[var(--border)]',
  },
};

export function Badge({ status = 'neutral', label, dot = false, className = '' }: BadgeProps) {
  const styles = statusStyles[status];

  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
        styles.badge,
        className,
      ].join(' ')}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={['w-1.5 h-1.5 rounded-full flex-shrink-0', styles.dot].join(' ')}
        />
      )}
      {label}
    </span>
  );
}

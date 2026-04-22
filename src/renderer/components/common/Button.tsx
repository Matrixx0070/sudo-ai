import React from 'react';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: React.ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-[var(--accent)] hover:bg-blue-500 text-white font-medium',
  secondary:
    'bg-[var(--bg-card)] hover:bg-[var(--border)] text-[var(--text-primary)] border border-[var(--border)]',
  danger:
    'bg-[var(--accent-red)] hover:bg-red-500 text-white font-medium',
  ghost:
    'bg-transparent hover:bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-md gap-1.5',
  md: 'px-4 py-2 text-sm rounded-lg gap-2',
  lg: 'px-5 py-2.5 text-base rounded-lg gap-2.5',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      disabled={isDisabled}
      className={[
        'inline-flex items-center justify-center transition-colors duration-150 cursor-pointer select-none',
        'focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].join(' ')}
      {...props}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}

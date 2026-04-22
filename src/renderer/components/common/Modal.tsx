import React, { useEffect, useRef } from 'react';
import { Button } from './Button';

interface ModalAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
}

interface ModalProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  actions?: ModalAction[];
  onClose: () => void;
  width?: 'sm' | 'md' | 'lg';
}

const widthMap = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

export function Modal({ open, title, children, actions, onClose, width = 'md' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={dialogRef}
        className={[
          'relative w-full rounded-xl border border-[var(--border)]',
          'bg-[var(--bg-secondary)] shadow-2xl animate-fade-in',
          widthMap[width],
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <h2 id="modal-title" className="text-base font-semibold text-[var(--text-primary)]">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors p-1 rounded-md hover:bg-[var(--bg-card)]"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 text-sm text-[var(--text-secondary)]">{children}</div>

        {/* Actions */}
        {actions && actions.length > 0 && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--border)]">
            {actions.map((action) => (
              <Button
                key={action.label}
                variant={action.variant ?? 'secondary'}
                size="sm"
                loading={action.loading}
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

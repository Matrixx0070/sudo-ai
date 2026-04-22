import React, { createContext, useCallback, useContext, useState, useRef } from 'react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

const typeConfig: Record<ToastType, { icon: string; colorClass: string }> = {
  success: { icon: '✓', colorClass: 'border-[var(--accent-green)] text-[var(--accent-green)]' },
  error: { icon: '✕', colorClass: 'border-[var(--accent-red)] text-[var(--accent-red)]' },
  info: { icon: 'i', colorClass: 'border-[var(--accent)] text-[var(--accent)]' },
  warning: { icon: '!', colorClass: 'border-[var(--accent-yellow)] text-[var(--accent-yellow)]' },
};

function ToastItem({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const cfg = typeConfig[item.type];
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={[
        'flex items-start gap-3 px-4 py-3 rounded-lg border-l-2',
        'bg-[var(--bg-secondary)] shadow-xl text-sm animate-slide-in',
        'min-w-[280px] max-w-xs',
        cfg.colorClass,
      ].join(' ')}
    >
      <span className="font-bold flex-shrink-0 w-4 text-center">{cfg.icon}</span>
      <span className="text-[var(--text-primary)] flex-1">{item.message}</span>
      <button
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex-shrink-0 ml-1"
      >
        ×
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((type: ToastType, message: string) => {
    const id = `toast-${++counterRef.current}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        aria-label="Notifications"
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
      >
        {toasts.map((item) => (
          <ToastItem key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

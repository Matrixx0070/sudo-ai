import React from 'react';

interface StatusDotProps {
  status: 'online' | 'warning' | 'error' | 'offline';
  label?: string;
  pulse?: boolean;
}

const COLOR_MAP: Record<StatusDotProps['status'], string> = {
  online: '#22c55e',
  warning: '#eab308',
  error: '#ef4444',
  offline: '#6b7280',
};

const PULSE_COLOR_MAP: Record<StatusDotProps['status'], string> = {
  online: 'rgba(34,197,94,0.35)',
  warning: 'rgba(234,179,8,0.35)',
  error: 'rgba(239,68,68,0.35)',
  offline: 'rgba(107,114,128,0.35)',
};

// Keyframes injected once
let keyframesInjected = false;
function ensureKeyframes() {
  if (keyframesInjected || typeof document === 'undefined') return;
  keyframesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes sudo-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(2.2); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

export function StatusDot({ status, label, pulse = false }: StatusDotProps) {
  if (pulse) ensureKeyframes();

  const color = COLOR_MAP[status];
  const pulseColor = PULSE_COLOR_MAP[status];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
      }}
      aria-label={label ? `${label}: ${status}` : status}
    >
      {/* Dot wrapper — needed for relative pulse ring */}
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '10px',
          height: '10px',
          flexShrink: 0,
        }}
      >
        {pulse && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              backgroundColor: pulseColor,
              animation: 'sudo-pulse 1.8s ease-in-out infinite',
            }}
          />
        )}
        <span
          aria-hidden="true"
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: color,
            flexShrink: 0,
          }}
        />
      </span>

      {label && (
        <span
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary, #9ca3af)',
            lineHeight: 1.4,
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

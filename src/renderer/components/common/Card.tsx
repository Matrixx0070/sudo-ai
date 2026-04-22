import React from 'react';

interface CardProps {
  title?: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Card({ title, subtitle, icon, children, footer, style }: CardProps) {
  const hasHeader = title || subtitle || icon;

  return (
    <div
      style={{
        backgroundColor: '#111827',
        border: '1px solid #1f2937',
        borderRadius: '12px',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        ...style,
      }}
    >
      {hasHeader && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px',
          }}
        >
          {icon && (
            <div
              style={{
                flexShrink: 0,
                color: 'var(--accent, #3b82f6)',
                display: 'flex',
                alignItems: 'center',
              }}
              aria-hidden="true"
            >
              {icon}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && (
              <h3
                style={{
                  margin: 0,
                  fontSize: '14px',
                  fontWeight: 600,
                  color: 'var(--text-primary, #f9fafb)',
                  lineHeight: 1.4,
                }}
              >
                {title}
              </h3>
            )}
            {subtitle && (
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: '12px',
                  color: 'var(--text-secondary, #9ca3af)',
                  lineHeight: 1.4,
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
        </div>
      )}

      <div style={{ flex: 1 }}>{children}</div>

      {footer && (
        <div
          style={{
            borderTop: '1px solid #1f2937',
            paddingTop: '12px',
            marginTop: '4px',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

import React from 'react';

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (tabId: string) => void;
}

export function Tabs({ tabs, activeTab, onChange }: TabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Section navigation"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        borderBottom: '1px solid #1f2937',
        overflowX: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            id={`tab-${tab.id}`}
            onClick={() => onChange(tab.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              fontSize: '13px',
              fontWeight: isActive ? 600 : 400,
              color: isActive
                ? 'var(--accent, #3b82f6)'
                : 'var(--text-secondary, #9ca3af)',
              background: 'none',
              border: 'none',
              borderBottom: isActive
                ? '2px solid var(--accent, #3b82f6)'
                : '2px solid transparent',
              marginBottom: '-1px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'color 150ms ease, border-color 150ms ease',
              borderRadius: '4px 4px 0 0',
              outline: 'none',
            }}
            onFocus={(e) => {
              (e.currentTarget as HTMLElement).style.outline =
                '2px solid var(--accent, #3b82f6)';
              (e.currentTarget as HTMLElement).style.outlineOffset = '-2px';
            }}
            onBlur={(e) => {
              (e.currentTarget as HTMLElement).style.outline = 'none';
            }}
          >
            {tab.icon && (
              <span
                aria-hidden="true"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  color: isActive
                    ? 'var(--accent, #3b82f6)'
                    : 'var(--text-secondary, #9ca3af)',
                }}
              >
                {tab.icon}
              </span>
            )}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

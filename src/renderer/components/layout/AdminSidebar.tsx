import React, { useState } from 'react';
import type { View } from '@renderer/App';

interface AdminSidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconBuilding() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="16" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 5V3.5A1.5 1.5 0 017.5 2h5A1.5 1.5 0 0114 3.5V5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="5" y="10" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="12" y="10" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 18v-4h4v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconMessage() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 5a2 2 0 012-2h10a2 2 0 012 2v7a2 2 0 01-2 2H7l-4 3V5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="2" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconChip() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5V3M12 5V3M8 17v-2M12 17v-2M5 8H3M5 12H3M15 8h2M15 12h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="7.5" y="7.5" width="5" height="5" rx="0.75" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M17 3L2 9l6 2 2 6 7-14z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 11l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconWrench() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M14.5 3a3.5 3.5 0 00-3.44 4.13L4.5 13.5a1.5 1.5 0 002.12 2.12l6.37-6.56A3.5 3.5 0 0014.5 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="5.5" cy="14.5" r="1" fill="currentColor" />
    </svg>
  );
}

function IconSparkle() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2l1.5 5.5L17 9l-5.5 1.5L10 16l-1.5-5.5L3 9l5.5-1.5L10 2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M16 2l.75 2.25L19 5l-2.25.75L16 8l-.75-2.25L13 5l2.25-.75L16 2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 2L3 5v5c0 4 3.13 7.45 7 8 3.87-.55 7-4 7-8V5l-7-3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7 10l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 8l3 3-3 3M11 14h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconServer() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="12" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
      <circle cx="5.5" cy="14.5" r="1" fill="currentColor" />
      <path d="M9 5.5h5M9 14.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="7.5" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 17c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="14" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M18 17c0-2.5-1.8-4-4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Nav section data
// ---------------------------------------------------------------------------

interface NavItem {
  view: View;
  label: string;
  icon: React.ReactNode;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'MAIN',
    items: [
      { view: 'office',            label: 'Office',        icon: <IconBuilding /> },
      { view: 'chat',              label: 'Chat',           icon: <IconMessage /> },
      { view: 'admin-dashboard',   label: 'Dashboard',     icon: <IconGrid /> },
    ],
  },
  {
    title: 'MANAGE',
    items: [
      { view: 'admin-models',        label: 'AI Models',      icon: <IconChip /> },
      { view: 'admin-channels',      label: 'Channels',       icon: <IconSend /> },
      { view: 'admin-tools',         label: 'Tools',          icon: <IconWrench /> },
      { view: 'admin-consciousness', label: 'Consciousness',  icon: <IconSparkle /> },
      { view: 'admin-cron',          label: 'Cron Jobs',      icon: <IconClock /> },
    ],
  },
  {
    title: 'SYSTEM',
    items: [
      { view: 'admin-settings',  label: 'Settings',  icon: <IconGear /> },
      { view: 'admin-security',  label: 'Security',  icon: <IconShield /> },
      { view: 'admin-logs',      label: 'Logs',      icon: <IconTerminal /> },
      { view: 'admin-system',    label: 'System',    icon: <IconServer /> },
      { view: 'admin-sessions',  label: 'Sessions',  icon: <IconUsers /> },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminSidebar({ activeView, onNavigate }: AdminSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const EXPANDED_WIDTH = 220;
  const COLLAPSED_WIDTH = 60;
  const width = collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  return (
    <nav
      aria-label="Admin navigation"
      style={{
        width: `${width}px`,
        minWidth: `${width}px`,
        height: '100%',
        background: '#111827',
        borderRight: '1px solid #1f2937',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        overflow: 'hidden',
        transition: 'width 0.2s ease, min-width 0.2s ease',
      }}
    >
      {/* Top: toggle + brand */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: collapsed ? '12px 0' : '12px 12px',
          justifyContent: collapsed ? 'center' : 'space-between',
          borderBottom: '1px solid #1f2937',
          flexShrink: 0,
          height: '56px',
          boxSizing: 'border-box',
        }}
      >
        {/* Brand — hidden when collapsed */}
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
            <div
              aria-hidden="true"
              style={{
                width: '28px',
                height: '28px',
                background: '#3b82f6',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span style={{ color: '#fff', fontWeight: 700, fontSize: '11px' }}>S</span>
            </div>
            <span
              style={{
                color: '#f9fafb',
                fontWeight: 700,
                fontSize: '14px',
                letterSpacing: '-0.2px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              SUDO-AI
            </span>
          </div>
        )}

        {/* Collapsed: show logo only */}
        {collapsed && (
          <div
            aria-hidden="true"
            style={{
              width: '28px',
              height: '28px',
              background: '#3b82f6',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ color: '#fff', fontWeight: 700, fontSize: '11px' }}>S</span>
          </div>
        )}

        {/* Toggle button — only visible when expanded */}
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f3f4f6'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6b7280'; }}
          >
            <IconChevronLeft />
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0', flexShrink: 0 }}>
          <button
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f3f4f6'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#6b7280'; }}
          >
            <IconChevronRight />
          </button>
        </div>
      )}

      {/* Nav sections */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: collapsed ? '8px 0' : '8px 0',
        }}
      >
        {NAV_SECTIONS.map((section) => (
          <div key={section.title} style={{ marginBottom: '4px' }}>
            {/* Section label — hidden when collapsed */}
            {!collapsed && (
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  color: '#4b5563',
                  textTransform: 'uppercase',
                  padding: '12px 16px 4px',
                  userSelect: 'none',
                }}
              >
                {section.title}
              </div>
            )}

            {/* Divider when collapsed */}
            {collapsed && (
              <div
                aria-hidden="true"
                style={{
                  height: '1px',
                  background: '#1f2937',
                  margin: '6px 8px',
                }}
              />
            )}

            <ul role="list" style={{ listStyle: 'none', margin: 0, padding: '0 8px' }}>
              {section.items.map((item) => {
                const isActive = activeView === item.view;
                return (
                  <li key={item.view}>
                    <NavButton
                      item={item}
                      isActive={isActive}
                      collapsed={collapsed}
                      onNavigate={onNavigate}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// NavButton — extracted to manage hover state without inline closures on style
// ---------------------------------------------------------------------------

interface NavButtonProps {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  onNavigate: (view: View) => void;
}

function NavButton({ item, isActive, collapsed, onNavigate }: NavButtonProps) {
  const [hovered, setHovered] = useState(false);

  const bg = isActive ? '#1e3a5f' : hovered ? '#1f2937' : 'transparent';
  const color = isActive ? '#ffffff' : hovered ? '#f3f4f6' : '#9ca3af';

  return (
    <button
      onClick={() => onNavigate(item.view)}
      aria-label={item.label}
      aria-current={isActive ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        width: '100%',
        padding: collapsed ? '8px 0' : '7px 10px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: '6px',
        border: 'none',
        borderLeft: isActive && !collapsed ? '2px solid #3b82f6' : '2px solid transparent',
        cursor: 'pointer',
        background: bg,
        color,
        fontSize: '13px',
        fontWeight: isActive ? 600 : 400,
        fontFamily: 'Inter, sans-serif',
        transition: 'background 0.12s, color 0.12s',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        marginBottom: '1px',
        boxSizing: 'border-box',
        paddingLeft: isActive && !collapsed ? '8px' : collapsed ? undefined : '10px',
      }}
    >
      <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        {item.icon}
      </span>
      {!collapsed && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.label}
        </span>
      )}
    </button>
  );
}

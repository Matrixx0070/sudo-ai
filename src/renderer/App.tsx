import React, { Suspense, useState } from 'react';
import { Shell } from '@renderer/components/layout/Shell';
import { DashboardView } from '@renderer/components/dashboard/DashboardView';
import { ChatView } from '@renderer/components/chat/ChatView';
import { PipelineView } from '@renderer/components/pipeline/PipelineView';
import { SkillsView } from '@renderer/components/skills/SkillsView';
import { SystemView } from '@renderer/components/system/SystemView';
import { SettingsView } from '@renderer/components/settings/SettingsView';
import { isWeb } from '@renderer/lib/env';

// Lazy-load admin pages for code splitting (all use named exports)
const AdminDashboardPage = React.lazy(() =>
  import('@renderer/components/admin/dashboard/AdminDashboardPage').then(m => ({ default: m.AdminDashboardPage }))
);
const ModelsPage = React.lazy(() =>
  import('@renderer/components/admin/models/ModelsPage').then(m => ({ default: m.ModelsPage }))
);
const ChannelsPage = React.lazy(() =>
  import('@renderer/components/admin/channels/ChannelsPage').then(m => ({ default: m.ChannelsPage }))
);
const ToolsPage = React.lazy(() =>
  import('@renderer/components/admin/tools/ToolsPage').then(m => ({ default: m.ToolsPage }))
);
const ConsciousnessPage = React.lazy(() =>
  import('@renderer/components/admin/consciousness/ConsciousnessPage').then(m => ({ default: m.ConsciousnessPage }))
);
const CronPage = React.lazy(() =>
  import('@renderer/components/admin/cron/CronPage').then(m => ({ default: m.CronPage }))
);
const AdminSettingsPage = React.lazy(() =>
  import('@renderer/components/admin/settings/AdminSettingsPage').then(m => ({ default: m.AdminSettingsPage }))
);
const SecurityPage = React.lazy(() =>
  import('@renderer/components/admin/security/SecurityPage').then(m => ({ default: m.SecurityPage }))
);
const LogsPage = React.lazy(() =>
  import('@renderer/components/admin/logs/LogsPage').then(m => ({ default: m.LogsPage }))
);
const AdminSystemPage = React.lazy(() =>
  import('@renderer/components/admin/system/AdminSystemPage').then(m => ({ default: m.AdminSystemPage }))
);
const SessionsPage = React.lazy(() =>
  import('@renderer/components/admin/sessions/SessionsPage').then(m => ({ default: m.SessionsPage }))
);

export type View =
  | 'chat' | 'dashboard' | 'pipeline' | 'skills' | 'system' | 'settings'
  | 'admin-dashboard' | 'admin-models' | 'admin-channels'
  | 'admin-tools' | 'admin-consciousness' | 'admin-cron'
  | 'admin-settings' | 'admin-security' | 'admin-logs'
  | 'admin-system' | 'admin-sessions';

function LoadingFallback() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#6b7280',
        fontSize: '14px',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      Loading...
    </div>
  );
}

function ViewContent({ view }: { view: View }) {
  const content = (() => {
    switch (view) {
      case 'dashboard':
        return <DashboardView />;
      case 'chat':
        return <ChatView />;
      case 'pipeline':
        return <PipelineView />;
      case 'skills':
        return <SkillsView />;
      case 'system':
        return <SystemView />;
      case 'settings':
        return <SettingsView />;
      case 'admin-dashboard':
        return <AdminDashboardPage />;
      case 'admin-models':
        return <ModelsPage />;
      case 'admin-channels':
        return <ChannelsPage />;
      case 'admin-tools':
        return <ToolsPage />;
      case 'admin-consciousness':
        return <ConsciousnessPage />;
      case 'admin-cron':
        return <CronPage />;
      case 'admin-settings':
        return <AdminSettingsPage />;
      case 'admin-security':
        return <SecurityPage />;
      case 'admin-logs':
        return <LogsPage />;
      case 'admin-system':
        return <AdminSystemPage />;
      case 'admin-sessions':
        return <SessionsPage />;
      default:
        return null;
    }
  })();

  return (
    <Suspense fallback={<LoadingFallback />}>
      {content}
    </Suspense>
  );
}

export function App() {
  const [activeView, setActiveView] = useState<View>(isWeb ? 'admin-dashboard' : 'dashboard');

  return (
    <Shell activeView={activeView} onNavigate={setActiveView}>
      <ViewContent view={activeView} />
    </Shell>
  );
}

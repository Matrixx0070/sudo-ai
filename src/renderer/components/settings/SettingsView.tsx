import React, { useEffect, useState } from 'react';
import { ApiKeys } from './ApiKeys';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { Button } from '@renderer/components/common/Button';
import { useToast } from '@renderer/components/common/Toast';

type Tab = 'api-keys' | 'models' | 'channels' | 'cron' | 'system';

const TABS: { id: Tab; label: string }[] = [
  { id: 'api-keys', label: 'API Keys' },
  { id: 'models', label: 'Models' },
  { id: 'channels', label: 'Channels' },
  { id: 'cron', label: 'Cron' },
  { id: 'system', label: 'System' },
];

function ModelsTab() {
  const { modelConfig, setModelConfig, save } = useSettingsStore();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await save();
      toast('success', 'Model config saved.');
    } catch {
      toast('error', 'Failed to save model config.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {(
          [
            { key: 'primary' as const, label: 'Primary Model' },
            { key: 'fallback' as const, label: 'Fallback Model' },
          ]
        ).map(({ key, label }) => (
          <div key={key} className="space-y-1.5">
            <label htmlFor={`model-${key}`} className="text-xs font-medium text-[var(--text-primary)]">
              {label}
            </label>
            <input
              id={`model-${key}`}
              type="text"
              value={modelConfig[key]}
              onChange={(e) => setModelConfig({ [key]: e.target.value })}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] font-mono"
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label htmlFor="model-temp" className="text-xs font-medium text-[var(--text-primary)]">
            Temperature: <span className="text-[var(--accent)]">{modelConfig.temperature}</span>
          </label>
          <input
            id="model-temp"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={modelConfig.temperature}
            onChange={(e) => setModelConfig({ temperature: parseFloat(e.target.value) })}
            className="w-full accent-[var(--accent)]"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="model-tokens" className="text-xs font-medium text-[var(--text-primary)]">
            Max Tokens
          </label>
          <input
            id="model-tokens"
            type="number"
            min="512"
            max="200000"
            value={modelConfig.maxTokens}
            onChange={(e) => setModelConfig({ maxTokens: parseInt(e.target.value) })}
            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>
      </div>

      <Button variant="primary" size="md" loading={saving} onClick={handleSave}>
        Save Model Config
      </Button>
    </div>
  );
}

function PlaceholderTab({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
      <span className="text-3xl" aria-hidden="true">⚙</span>
      <p className="text-sm text-[var(--text-secondary)]">{name} settings coming soon.</p>
    </div>
  );
}

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<Tab>('api-keys');
  const { load, loaded } = useSettingsStore();

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-5 pt-5 border-b border-[var(--border)] flex-shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Settings</h1>

        {/* Tabs */}
        <div role="tablist" aria-label="Settings sections" className="flex gap-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                activeTab === tab.id
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab panels */}
      <div className="flex-1 overflow-y-auto p-5">
        <div
          role="tabpanel"
          id={`panel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
        >
          {activeTab === 'api-keys' && <ApiKeys />}
          {activeTab === 'models' && <ModelsTab />}
          {activeTab === 'channels' && <PlaceholderTab name="Channels" />}
          {activeTab === 'cron' && <PlaceholderTab name="Cron" />}
          {activeTab === 'system' && <PlaceholderTab name="System" />}
        </div>
      </div>
    </div>
  );
}

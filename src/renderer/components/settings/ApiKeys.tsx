import React, { useState } from 'react';
import { useSettingsStore, type ApiKeys as ApiKeysType } from '@renderer/stores/settingsStore';
import { Button } from '@renderer/components/common/Button';
import { Badge } from '@renderer/components/common/Badge';
import { useToast } from '@renderer/components/common/Toast';

const API_KEY_FIELDS: { key: keyof ApiKeysType; label: string; placeholder: string }[] = [
  { key: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
  { key: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { key: 'xai', label: 'xAI (Grok)', placeholder: 'xai-...' },
  { key: 'google', label: 'Google AI', placeholder: 'AIza...' },
  { key: 'youtube', label: 'YouTube Data API', placeholder: 'AIza...' },
];

export function ApiKeys() {
  const { apiKeys, setApiKey, save } = useSettingsStore();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState<Set<keyof ApiKeysType>>(new Set());

  const toggleVisibility = (key: keyof ApiKeysType) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await save();
      toast('success', 'API keys saved successfully.');
    } catch {
      toast('error', 'Failed to save API keys.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--text-secondary)]">
        Keys are stored locally and never transmitted outside the app.
      </p>

      {API_KEY_FIELDS.map(({ key, label, placeholder }) => {
        const value = apiKeys[key];
        const isConfigured = value.length > 0;
        const isVisible = visibleKeys.has(key);

        return (
          <div key={key} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor={`apikey-${key}`} className="text-xs font-medium text-[var(--text-primary)]">
                {label}
              </label>
              <Badge
                status={isConfigured ? 'online' : 'offline'}
                label={isConfigured ? 'Configured' : 'Missing'}
                dot
              />
            </div>
            <div className="relative flex items-center">
              <input
                id={`apikey-${key}`}
                type={isVisible ? 'text' : 'password'}
                value={value}
                onChange={(e) => setApiKey(key, e.target.value)}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                className={[
                  'w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg',
                  'px-3 py-2 pr-10 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]',
                  'focus:outline-none focus:ring-1 focus:ring-[var(--accent)] font-mono',
                ].join(' ')}
              />
              <button
                type="button"
                onClick={() => toggleVisibility(key)}
                aria-label={isVisible ? `Hide ${label} key` : `Show ${label} key`}
                className="absolute right-2.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {isVisible ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" strokeWidth="1.3" />
                    <line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" strokeWidth="1.3" />
                    <circle cx="7" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        );
      })}

      <div className="pt-2">
        <Button variant="primary" size="md" loading={saving} onClick={handleSave}>
          Save API Keys
        </Button>
      </div>
    </div>
  );
}

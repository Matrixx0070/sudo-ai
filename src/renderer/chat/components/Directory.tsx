import React from 'react';
import {
  fetchDirectory,
  installItem,
  type DirectoryData,
  type DirectoryKind,
  type ConnectorItem,
  type PluginItem,
  type SkillItem,
} from '../directory';

type Tab = 'skills' | 'connectors' | 'plugins';

interface DirectoryProps {
  onClose: () => void;
}

/** claude.ai-style Directory: Skills / Connectors / Plugins from SUDO's own registry. */
export function Directory({ onClose }: DirectoryProps) {
  const [tab, setTab] = React.useState<Tab>('skills');
  const [data, setData] = React.useState<DirectoryData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<{ ok: boolean; text: string } | null>(null);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchDirectory()
      .then((d) => { if (alive) { setData(d); setLoadError(null); } })
      .catch((e: unknown) => { if (alive) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const kindOf = (t: Tab): DirectoryKind => (t === 'skills' ? 'skill' : t === 'connectors' ? 'connector' : 'plugin');

  async function handleInstall(name: string) {
    const kind = kindOf(tab);
    setBusy(name);
    setToast(null);
    try {
      const r = await installItem(kind, name, false);
      setToast({ ok: r.ok, text: r.ok ? `Installed ${kind} "${name}"` : (r.output || r.error || `Failed to install ${name}`) });
    } catch (e) {
      setToast({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const q = query.trim().toLowerCase();
  const matches = (hay: string) => !q || hay.toLowerCase().includes(q);

  const skills = (data?.skills ?? []).filter((s: SkillItem) => matches(`${s.name} ${s.description ?? ''} ${(s.tags ?? []).join(' ')}`));
  const connectors = (data?.connectors ?? []).filter((c: ConnectorItem) => matches(`${c.name} ${c.displayName ?? ''} ${c.description ?? ''} ${(c.tags ?? []).join(' ')}`));
  const plugins = (data?.plugins ?? []).filter((p: PluginItem) => matches(`${p.name} ${p.displayName ?? ''} ${p.description ?? ''} ${(p.tags ?? []).join(' ')}`));

  const counts = { skills: data?.skills.length ?? 0, connectors: data?.connectors.length ?? 0, plugins: data?.plugins.length ?? 0 };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
          <h2 className="text-base font-semibold">Directory</h2>
          <span className="text-xs text-gray-500">SUDO registry · sudoapi.shop</span>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-100 text-xl leading-none px-2" title="Close">×</button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-3">
          {(['skills', 'connectors', 'plugins'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm rounded-lg capitalize transition-colors ${
                tab === t ? 'bg-blue-500/20 text-blue-300 font-medium' : 'text-gray-400 hover:text-gray-100'
              }`}
            >
              {t} <span className="text-xs text-gray-500">{counts[t]}</span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-4 py-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab}…`}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
          {loading && <p className="text-sm text-gray-400 py-8 text-center">Loading catalog…</p>}
          {loadError && <p className="text-sm text-red-400 py-8 text-center">Failed to load Directory: {loadError}</p>}

          {!loading && !loadError && data && (
            <>
              {data.errors?.[tab] && (
                <p className="text-xs text-amber-400/80 pb-1">Catalog note: {data.errors[tab]}</p>
              )}

              {tab === 'skills' && skills.map((s) => (
                <Card
                  key={s.name}
                  title={s.name}
                  subtitle={s.version ? `v${s.version}${s.author ? ` · ${s.author}` : ''}` : s.author}
                  desc={s.description}
                  tags={s.tags}
                  busy={busy === s.name}
                  onAdd={() => handleInstall(s.name)}
                />
              ))}

              {tab === 'connectors' && connectors.map((c) => (
                <Card
                  key={c.name}
                  title={c.displayName || c.name}
                  subtitle={`${c.category ?? 'other'}${c.verified ? ' · ✓ verified' : ''}${c.live ? ' · LIVE' : c.requiresOAuth ? ' · OAuth' : ''}`}
                  desc={c.description}
                  tags={c.tags}
                  disabled={!c.live}
                  disabledLabel={c.requiresOAuth ? 'OAuth' : 'N/A'}
                  busy={busy === c.name}
                  onAdd={() => handleInstall(c.name)}
                />
              ))}

              {tab === 'plugins' && plugins.map((p) => (
                <Card
                  key={p.name}
                  title={p.displayName || p.name}
                  subtitle={`${p.category ?? 'other'} · ${(p.skills ?? []).length} skills · ${(p.connectors ?? []).length} connectors`}
                  desc={p.description}
                  tags={p.tags}
                  busy={busy === p.name}
                  onAdd={() => handleInstall(p.name)}
                />
              ))}

              {((tab === 'skills' && skills.length === 0) ||
                (tab === 'connectors' && connectors.length === 0) ||
                (tab === 'plugins' && plugins.length === 0)) && (
                <p className="text-sm text-gray-500 py-8 text-center">Nothing matches “{query}”.</p>
              )}
            </>
          )}
        </div>

        {/* Toast */}
        {toast && (
          <div className={`px-5 py-3 text-sm border-t ${toast.ok ? 'text-green-300 border-green-800 bg-green-900/20' : 'text-red-300 border-red-800 bg-red-900/20'}`}>
            {toast.text}
          </div>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  title: string;
  subtitle?: string;
  desc?: string;
  tags?: string[];
  busy?: boolean;
  disabled?: boolean;
  disabledLabel?: string;
  onAdd: () => void;
}

function Card({ title, subtitle, desc, tags, busy, disabled, disabledLabel, onAdd }: CardProps) {
  return (
    <div className="flex items-start gap-3 bg-gray-800/60 border border-gray-700 rounded-lg px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm text-gray-100 truncate">{title}</span>
          {subtitle && <span className="text-xs text-gray-500 truncate">{subtitle}</span>}
        </div>
        {desc && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{desc}</p>}
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tags.slice(0, 5).map((t) => (
              <span key={t} className="text-[10px] text-gray-400 bg-gray-700/60 rounded px-1.5 py-0.5">{t}</span>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onAdd}
        disabled={busy || disabled}
        className={`shrink-0 text-xs rounded-lg px-3 py-1.5 border transition-colors ${
          disabled
            ? 'text-gray-600 border-gray-800 cursor-not-allowed'
            : busy
              ? 'text-gray-500 border-gray-700 cursor-wait'
              : 'text-blue-300 border-blue-700 hover:bg-blue-500/10'
        }`}
      >
        {disabled ? (disabledLabel ?? '—') : busy ? 'Adding…' : 'Add'}
      </button>
    </div>
  );
}

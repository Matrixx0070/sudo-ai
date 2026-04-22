import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { SearchInput } from '@renderer/components/common/SearchInput.js';
import { Toggle } from '@renderer/components/common/Toggle.js';
import { Spinner } from '@renderer/components/common/Spinner.js';
import * as api from '@renderer/lib/admin-api.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Tool {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  fileCount: number;
}

type ToolStats = Record<string, { calls: number; avgDurationMs: number; errors: number }>;

// ─── Category label map ───────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  browser: 'Browser',
  system: 'System',
  research: 'Research',
  coder: 'Coder',
  dev: 'Dev',
  social: 'Social',
  media: 'Media',
  comms: 'Communications',
  meta: 'Meta',
};

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ToolCardProps {
  tool: Tool;
  stats: ToolStats;
  onToggle: (name: string, enabled: boolean) => void;
  toggling: string | null;
}

function ToolCard({ tool, stats, onToggle, toggling }: ToolCardProps) {
  const s = stats[tool.name];
  return (
    <article
      aria-label={tool.name}
      style={{
        backgroundColor: '#111827',
        border: '1px solid #1f2937',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#f9fafb', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tool.name}
          </h4>
          <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#6b7280', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {tool.description || 'No description.'}
          </p>
        </div>
        <span
          aria-label={`${tool.fileCount} file${tool.fileCount !== 1 ? 's' : ''}`}
          style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '999px', backgroundColor: '#1f2937', color: '#9ca3af', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {tool.fileCount} {tool.fileCount === 1 ? 'file' : 'files'}
        </span>
      </div>

      {s && (
        <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: '#6b7280' }}>
          <span>{s.calls} calls</span>
          <span>{s.avgDurationMs}ms avg</span>
          {s.errors > 0 && <span style={{ color: '#ef4444' }}>{s.errors} errors</span>}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <Toggle
          label={tool.enabled ? 'Enabled' : 'Disabled'}
          checked={tool.enabled}
          onChange={(val) => onToggle(tool.name, val)}
          disabled={toggling === tool.name}
        />
      </div>
    </article>
  );
}

interface CategoryGroupProps {
  category: string;
  tools: Tool[];
  stats: ToolStats;
  onToggle: (name: string, enabled: boolean) => void;
  toggling: string | null;
}

function CategoryGroup({ category, tools, stats, onToggle, toggling }: CategoryGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const enabledCount = tools.filter((t) => t.enabled).length;

  return (
    <section aria-label={`${categoryLabel(category)} tools`} style={{ marginBottom: '24px' }}>
      <button
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          background: 'none', border: 'none', cursor: 'pointer', padding: '6px 0',
          marginBottom: '10px', textAlign: 'left',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: '11px', color: '#9ca3af', transition: 'transform 150ms ease', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>&#9660;</span>
        <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#d1d5db', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {categoryLabel(category)}
        </h3>
        <span style={{ fontSize: '11px', color: '#6b7280', marginLeft: '4px' }}>
          {enabledCount}/{tools.length} active
        </span>
      </button>

      {!collapsed && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
          {tools.map((tool) => (
            <ToolCard key={tool.name} tool={tool} stats={stats} onToggle={onToggle} toggling={toggling} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [stats, setStats] = useState<ToolStats>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [toolsData, statsData] = await Promise.all([
        api.fetchTools() as Promise<Tool[]>,
        api.fetchToolStats() as Promise<ToolStats>,
      ]);
      setTools(toolsData);
      setStats(statsData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tools.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    setToggling(name);
    try {
      await api.toggleTool(name, enabled);
      setTools((prev) => prev.map((t) => t.name === name ? { ...t, enabled } : t));
    } catch {
      // revert handled by not updating state on error
    } finally {
      setToggling(null);
    }
  }, []);

  const categories = useMemo(() => Array.from(new Set(tools.map((t) => t.category))).sort(), [tools]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tools.filter((t) => {
      const matchesCat = categoryFilter === 'all' || t.category === categoryFilter;
      const matchesSearch = !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
      return matchesCat && matchesSearch;
    });
  }, [tools, search, categoryFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, Tool[]>();
    filtered.forEach((t) => {
      const arr = map.get(t.category) ?? [];
      arr.push(t);
      map.set(t.category, arr);
    });
    return map;
  }, [filtered]);

  const enabledTotal = tools.filter((t) => t.enabled).length;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px', color: '#9ca3af' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <main style={{ padding: '24px', fontFamily: 'Inter, system-ui, sans-serif', backgroundColor: '#0a0e1a', minHeight: '100%' }}>
      <header style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700, color: '#f9fafb' }}>Tools</h1>
        <p style={{ margin: 0, fontSize: '13px', color: '#6b7280' }}>{enabledTotal} of {tools.length} tools enabled</p>
      </header>

      {error && (
        <div role="alert" style={{ padding: '12px 16px', borderRadius: '8px', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: '13px', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', marginBottom: '28px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', minWidth: '200px' }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search tools..." />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#9ca3af' }}>
          <span>Category</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filter by category"
            style={{ padding: '7px 10px', borderRadius: '8px', border: '1px solid #1f2937', backgroundColor: '#111827', color: '#f9fafb', fontSize: '13px', cursor: 'pointer', fontFamily: 'Inter, system-ui, sans-serif' }}
          >
            <option value="all">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>{categoryLabel(c)}</option>
            ))}
          </select>
        </label>
      </div>

      {grouped.size === 0 ? (
        <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '14px', padding: '40px 0' }}>No tools match your filter.</p>
      ) : (
        Array.from(grouped.entries()).map(([cat, catTools]) => (
          <CategoryGroup key={cat} category={cat} tools={catTools} stats={stats} onToggle={handleToggle} toggling={toggling} />
        ))
      )}
    </main>
  );
}

/**
 * CanvasPanel — renders an A2UI component tree pushed by the agent (Spec 2).
 * Every value is rendered as React children (auto-escaped text) — no
 * dangerouslySetInnerHTML anywhere — so even if a malformed payload slipped the
 * server validator, there is no HTML/script injection path on the client.
 *
 * Button/form interactions call onEvent({kind, actionId, values}); App wires that
 * to POST /v1/canvas/event.
 */
import React from 'react';

// Loose local mirror of the server schema (renderer is a separate bundle).
// `type` is read defensively in the switch (unknown → rendered as nothing).
type Comp = Record<string, unknown>;
export interface CanvasData { version?: number; title?: string; components: Comp[] }
export interface CanvasEventOut { kind: 'button' | 'form'; actionId: string; values?: Record<string, string | number | boolean> }

// The canvas schema version this renderer understands (mirrors
// CANVAS_SCHEMA_VERSION in src/core/canvas/schema.ts). A payload with a higher
// version is REFUSED rather than mis-rendered — the schema's versioning contract.
export const SUPPORTED_CANVAS_VERSION = 1;

function Metric({ c }: { c: Comp }) {
  const trend = c['trend'] as string | undefined;
  const color = trend === 'up' ? 'text-green-400' : trend === 'down' ? 'text-red-400' : 'text-gray-400';
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
      <div className="text-xs text-gray-400">{String(c['label'] ?? '')}</div>
      <div className="text-xl font-semibold">{String(c['value'] ?? '')}</div>
      {c['delta'] != null && <div className={`text-xs ${color}`}>{String(c['delta'])}</div>}
    </div>
  );
}

// Distinct palette for pie slices / line accents (index-cycled). Plain CSS
// colours — no user input reaches style values (only computed geometry does).
const CHART_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#ec4899'];

function BarChart({ series, max }: { series: Array<{ label: string; value: number }>; max: number }) {
  return (
    <div className="space-y-1">
      {series.map((s, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="w-20 truncate text-gray-300">{String(s.label)}</span>
          <span className="flex-1 h-3 bg-gray-700 rounded"><span className="block h-3 bg-blue-500 rounded" style={{ width: `${Math.round(((Number(s.value) || 0) / max) * 100)}%` }} /></span>
          <span className="w-10 text-right text-gray-400">{String(s.value)}</span>
        </div>
      ))}
    </div>
  );
}

function LineChart({ series, max }: { series: Array<{ label: string; value: number }>; max: number }) {
  const W = 260, H = 80, pad = 6;
  const n = series.length;
  const pts = series.map((s, i) => {
    const x = n <= 1 ? pad : pad + (i * (W - 2 * pad)) / (n - 1);
    const y = H - pad - ((Number(s.value) || 0) / max) * (H - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none" role="img" aria-label="line chart">
        <polyline fill="none" stroke="#3b82f6" strokeWidth="2" points={pts} />
        {series.map((s, i) => {
          const x = n <= 1 ? pad : pad + (i * (W - 2 * pad)) / (n - 1);
          const y = H - pad - ((Number(s.value) || 0) / max) * (H - 2 * pad);
          return <circle key={i} cx={x} cy={y} r="2.5" fill="#3b82f6" />;
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
        {series.map((s, i) => <span key={i} className="truncate max-w-[3rem]">{String(s.label)}</span>)}
      </div>
    </div>
  );
}

function PieChart({ series }: { series: Array<{ label: string; value: number }> }) {
  const total = series.reduce((a, s) => a + (Number(s.value) || 0), 0) || 1;
  const R = 40, C = 50;
  let acc = 0;
  const arcs = series.map((s, i) => {
    const frac = (Number(s.value) || 0) / total;
    const a0 = acc * 2 * Math.PI - Math.PI / 2;
    acc += frac;
    const a1 = acc * 2 * Math.PI - Math.PI / 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0);
    const x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
    // A single full-circle slice can't be drawn as an arc (x0==x1) — use a circle.
    const d = frac >= 0.999
      ? undefined
      : `M ${C} ${C} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
    return { d, color: CHART_COLORS[i % CHART_COLORS.length], full: frac >= 0.999, label: String(s.label), value: Number(s.value) || 0 };
  });
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 100 100" className="w-24 h-24 shrink-0" role="img" aria-label="pie chart">
        {arcs.map((a, i) => a.full
          ? <circle key={i} cx={C} cy={C} r={R} fill={a.color} />
          : a.d && <path key={i} d={a.d} fill={a.color} />)}
      </svg>
      <div className="space-y-0.5 text-xs">
        {arcs.map((a, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: a.color }} />
            <span className="text-gray-300 truncate max-w-[8rem]">{a.label}</span>
            <span className="text-gray-500">{Math.round((a.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chart({ c }: { c: Comp }) {
  const series = Array.isArray(c['series']) ? (c['series'] as Array<{ label: string; value: number }>) : [];
  const max = Math.max(1, ...series.map((s) => Number(s.value) || 0));
  const chartType = c['chartType'];
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3">
      {c['title'] != null && <div className="text-xs text-gray-400 mb-2">{String(c['title'])}</div>}
      {chartType === 'pie' ? <PieChart series={series} />
        : chartType === 'line' ? <LineChart series={series} max={max} />
        : <BarChart series={series} max={max} />}
    </div>
  );
}

function Table({ c }: { c: Comp }) {
  const cols = Array.isArray(c['columns']) ? (c['columns'] as string[]) : [];
  const rows = Array.isArray(c['rows']) ? (c['rows'] as string[][]) : [];
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-700">
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-800">{cols.map((h, i) => <th key={i} className="px-2 py-1 text-left text-gray-300">{String(h)}</th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri} className="border-t border-gray-700">{r.map((cell, ci) => <td key={ci} className="px-2 py-1 text-gray-200">{String(cell)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Form({ c, onEvent }: { c: Comp; onEvent: (e: CanvasEventOut) => void }) {
  const fields = Array.isArray(c['fields']) ? (c['fields'] as Array<Record<string, unknown>>) : [];
  const [vals, setVals] = React.useState<Record<string, string | number | boolean>>({});
  const set = (name: string, v: string | number | boolean) => setVals((p) => ({ ...p, [name]: v }));
  return (
    <form
      className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 space-y-2"
      onSubmit={(e) => { e.preventDefault(); onEvent({ kind: 'form', actionId: String(c['submitActionId']), values: vals }); }}
    >
      {c['title'] != null && <div className="text-sm font-medium">{String(c['title'])}</div>}
      {fields.map((f, i) => {
        const name = String(f['name']); const kind = String(f['kind']); const label = String(f['label']);
        return (
          <label key={i} className="block text-xs text-gray-300">
            <span className="block mb-0.5">{label}{f['required'] ? ' *' : ''}</span>
            {kind === 'textarea' ? (
              <textarea className="w-full rounded bg-gray-900 border border-gray-700 px-2 py-1 text-gray-100" placeholder={String(f['placeholder'] ?? '')} onChange={(e) => set(name, e.target.value)} />
            ) : kind === 'select' ? (
              <select className="w-full rounded bg-gray-900 border border-gray-700 px-2 py-1 text-gray-100" onChange={(e) => set(name, e.target.value)}>
                <option value="">—</option>
                {(Array.isArray(f['options']) ? (f['options'] as string[]) : []).map((o, oi) => <option key={oi} value={o}>{String(o)}</option>)}
              </select>
            ) : kind === 'checkbox' ? (
              <input type="checkbox" className="align-middle" onChange={(e) => set(name, e.target.checked)} />
            ) : (
              <input type={kind === 'number' ? 'number' : 'text'} className="w-full rounded bg-gray-900 border border-gray-700 px-2 py-1 text-gray-100" placeholder={String(f['placeholder'] ?? '')} onChange={(e) => set(name, kind === 'number' ? Number(e.target.value) : e.target.value)} />
            )}
          </label>
        );
      })}
      <button type="submit" className="rounded bg-blue-600 hover:bg-blue-500 px-3 py-1 text-xs font-medium">{String(c['submitLabel'] ?? 'Submit')}</button>
    </form>
  );
}

function One({ c, onEvent }: { c: Comp; onEvent: (e: CanvasEventOut) => void }) {
  switch (c['type']) {
    case 'text': {
      const v = c['variant'];
      const cls = v === 'heading' ? 'text-base font-semibold' : v === 'caption' ? 'text-xs text-gray-400' : 'text-sm text-gray-200';
      return <p className={cls}>{String(c['text'] ?? '')}</p>;
    }
    case 'metric': return <Metric c={c} />;
    case 'chart': return <Chart c={c} />;
    case 'table': return <Table c={c} />;
    case 'progress': {
      const val = Math.max(0, Math.min(100, Number(c['value']) || 0));
      return (
        <div>
          {c['label'] != null && <div className="text-xs text-gray-400 mb-0.5">{String(c['label'])} — {val}%</div>}
          <div className="h-2 bg-gray-700 rounded"><div className="h-2 bg-blue-500 rounded" style={{ width: `${val}%` }} /></div>
        </div>
      );
    }
    case 'list': {
      const items = Array.isArray(c['items']) ? (c['items'] as string[]) : [];
      const Tag = c['ordered'] ? 'ol' : 'ul';
      return <Tag className={`text-sm text-gray-200 pl-5 ${c['ordered'] ? 'list-decimal' : 'list-disc'}`}>{items.map((it, i) => <li key={i}>{String(it)}</li>)}</Tag>;
    }
    case 'button': {
      const style = c['style'];
      const cls = style === 'danger' ? 'bg-red-600 hover:bg-red-500' : style === 'secondary' ? 'bg-gray-600 hover:bg-gray-500' : 'bg-blue-600 hover:bg-blue-500';
      return <button className={`rounded px-3 py-1 text-xs font-medium ${cls}`} onClick={() => onEvent({ kind: 'button', actionId: String(c['actionId']) })}>{String(c['label'] ?? '')}</button>;
    }
    case 'form': return <Form c={c} onEvent={onEvent} />;
    default: return null; // unknown type ignored (defensive; server already rejects)
  }
}

export function CanvasPanel({ data, onEvent }: { data: CanvasData; onEvent: (e: CanvasEventOut) => void }) {
  // Version contract: refuse a payload newer than this renderer understands
  // rather than mis-render it (schema.ts versioning promise). Older/unset =
  // treat as v1 (backward-compatible).
  if (typeof data.version === 'number' && data.version > SUPPORTED_CANVAS_VERSION) {
    return (
      <div className="rounded-xl border border-yellow-700/60 bg-yellow-900/20 p-3 my-2 text-xs text-yellow-300">
        This interactive panel needs a newer app version (canvas v{data.version}; this client supports v{SUPPORTED_CANVAS_VERSION}). Please refresh/update.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-3 my-2 space-y-2">
      {data.title && <div className="text-sm font-semibold text-blue-300">{data.title}</div>}
      {data.components.map((c, i) => <One key={i} c={c} onEvent={onEvent} />)}
    </div>
  );
}

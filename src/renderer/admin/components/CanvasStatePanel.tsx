import React from 'react';
import { Panel } from './shared/Panel';
import type { CanvasStateEntry } from '../hooks/useCanvasStates';

/**
 * Read-only monitor of the A2UI canvases the agent is rendering to sessions
 * (Spec 2). This is an operator view, NOT an interactive client — buttons and
 * forms are shown inert. Every value is rendered as React children (auto-
 * escaped); there is no dangerouslySetInnerHTML.
 */

type Comp = Record<string, unknown>;

function summarise(c: Comp): string {
  const t = String(c['type'] ?? '?');
  switch (t) {
    case 'text': return `text: ${String(c['text'] ?? '')}`;
    case 'metric': return `metric: ${String(c['label'] ?? '')} = ${String(c['value'] ?? '')}`;
    case 'chart': {
      const s = Array.isArray(c['series']) ? (c['series'] as Array<{ label: string; value: number }>) : [];
      return `chart${c['title'] ? ` "${String(c['title'])}"` : ''}: ${s.map((p) => `${p.label}=${p.value}`).join(', ')}`;
    }
    case 'table': {
      const rows = Array.isArray(c['rows']) ? (c['rows'] as unknown[]).length : 0;
      const cols = Array.isArray(c['columns']) ? (c['columns'] as unknown[]).length : 0;
      return `table: ${cols} cols × ${rows} rows`;
    }
    case 'form': {
      const f = Array.isArray(c['fields']) ? (c['fields'] as unknown[]).length : 0;
      return `form${c['title'] ? ` "${String(c['title'])}"` : ''}: ${f} field(s) → ${String(c['submitActionId'] ?? '?')}`;
    }
    case 'button': return `button: "${String(c['label'] ?? '')}" → ${String(c['actionId'] ?? '?')}`;
    case 'progress': return `progress: ${String(c['label'] ?? '')} ${String(c['value'] ?? '')}%`;
    case 'list': {
      const n = Array.isArray(c['items']) ? (c['items'] as unknown[]).length : 0;
      return `list: ${n} item(s)`;
    }
    default: return t;
  }
}

export const CanvasStatePanel: React.FC<{ states?: CanvasStateEntry[] | null }> = ({ states }) => {
  return (
    <Panel title="A2UI Canvases (live)" wide>
      {!states || states.length === 0 ? (
        <div className="text-[#8b949e] text-[12px]">No canvases rendered yet.</div>
      ) : (
        <div className="space-y-[10px]">
          {states.map((s) => (
            <div key={s.sessionId} className="border border-[#30363d] rounded-md p-[10px]">
              <div className="flex items-center justify-between gap-[8px] mb-[6px]">
                <span className="text-[#e6edf3] text-[12px]">
                  {s.title || <span className="text-[#8b949e]">(untitled)</span>}
                </span>
                <span className="text-[#8b949e] text-[11px]">{s.componentCount} comp · {s.updatedAt}</span>
              </div>
              <div className="text-[#8b949e] text-[11px] mb-[6px]">session {s.sessionId}</div>
              <ul className="text-[#c9d1d9] text-[12px] pl-[16px] list-disc space-y-[2px]">
                {s.components.map((c, i) => (
                  <li key={i}>{summarise(c as Comp)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
};

import React from 'react';
import type { ReanchorData } from '../hooks/useDigest';

interface ReanchorPanelProps {
  reanchor?: ReanchorData;
}

const scoreBar = (label: string, count: number, max: number): React.ReactNode => {
  const pctW = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div key={label} className="flex items-center gap-[8px] mb-[4px]">
      <span className="text-[11px] text-[#8b949e] w-[120px] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap" title={label}>
        {label}
      </span>
      <div className="flex-1 bg-[#21262d] rounded-[4px] h-[6px] overflow-hidden">
        <div className="h-full bg-[#1f6feb] rounded-[4px] transition-width duration-300" style={{ width: `${pctW}%` }} />
      </div>
      <span className="text-[11px] text-[#8b949e] w-[32px] text-right flex-shrink-0">{count}</span>
    </div>
  );
};

export const ReanchorPanel: React.FC<ReanchorPanelProps> = ({ reanchor }) => {
  const total = reanchor?.total ?? null;
  const byTrigger = reanchor?.byTrigger || {};
  const triggers = Object.keys(byTrigger);
  const maxCount = triggers.length > 0 ? Math.max(...triggers.map((k) => byTrigger[k])) : 0;

  return (
    <div className="wide-panel bg-[#161b22] border border-[#30363d] rounded-md p-[14px] mb-[12px]">
      <div className="text-[#8b949e] text-[11px] uppercase tracking-wider mb-[10px]">
        Re-Anchor Events by Trigger
      </div>
      <div className="mb-[8px]">
        Total:{' '}
        {total !== null ? (
          <strong className="text-[#e6edf3]">{total}</strong>
        ) : (
          <span className="text-[#6e7681] italic">—</span>
        )}
      </div>
      {triggers.length > 0 ? (
        triggers.map((trigger) => scoreBar(trigger, byTrigger[trigger], maxCount || 1))
      ) : (
        <div className="text-[#6e7681] italic">No trigger data</div>
      )}
    </div>
  );
};

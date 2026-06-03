import React from 'react';
import { Panel } from './shared/Panel';
import type { AlignmentData } from '../hooks/useDigest';

interface AlignmentPanelProps {
  alignment?: AlignmentData;
}

const levelClasses: Record<string, string> = {
  GREEN: 'bg-[#0d4429] text-[#3fb950] border border-[#1a7f37]',
  YELLOW: 'bg-[#3d2900] text-[#d29922] border border-[#9e6a03]',
  RED: 'bg-[#3d0000] text-[#f85149] border border-[#b62324]',
};

export const AlignmentPanel: React.FC<AlignmentPanelProps> = ({ alignment }) => {
  const score = alignment?.score ?? null;
  const level = alignment?.level ?? null;
  const diagnosis = alignment?.diagnosis ?? null;

  const scoreDisplay = score !== null ? `${(score * 100).toFixed(1)}%` : '—';
  const levelClass = level ? levelClasses[level] || '' : 'bg-[#21262d] text-[#8b949e] border border-[#30363d]';

  return (
    <Panel title="Alignment Score">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">{scoreDisplay}</div>
      <div className="text-[#8b949e] text-[12px]">
        Status:{' '}
        {level ? (
          <span className={`pill inline-block px-[8px] py-[2px] rounded-[12px] text-[11px] font-bold tracking-wide ${levelClass}`}>
            {level}
          </span>
        ) : (
          <span className="text-[#6e7681] italic">—</span>
        )}
      </div>
      {diagnosis && (
        <div className="text-[11px] text-[#6e7681] mt-[6px] break-words">{diagnosis}</div>
      )}
    </Panel>
  );
};

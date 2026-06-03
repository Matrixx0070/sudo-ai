import React from 'react';
import { Panel } from './shared/Panel';
import type { TrustData } from '../hooks/useDigest';

interface TrustPanelProps {
  trust?: TrustData;
}

const tierClasses: Record<string, string> = {
  HIGH: 'bg-[#0d4429] text-[#3fb950] border border-[#1a7f37]',
  MEDIUM: 'bg-[#3d2900] text-[#d29922] border border-[#9e6a03]',
  LOW: 'bg-[#3d0000] text-[#f85149] border border-[#b62324]',
};

export const TrustPanel: React.FC<TrustPanelProps> = ({ trust }) => {
  const tier = trust?.tier ?? null;
  const score = trust?.score ?? null;
  const windowSize = trust?.windowSizeDays ?? null;

  const tierClass = tier ? tierClasses[tier] || '' : 'bg-[#21262d] text-[#8b949e] border border-[#30363d]';

  return (
    <Panel title="Trust Tier">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">
        {tier ? (
          <span className={`pill inline-block px-[8px] py-[2px] rounded-[12px] text-[11px] font-bold tracking-wide ${tierClass}`}>
            {tier}
          </span>
        ) : (
          <span className="text-[#6e7681] italic">—</span>
        )}
      </div>
      <div className="text-[#8b949e] text-[12px]">
        Score:{' '}
        {score !== null ? (
          <span className="text-[#e6edf3]">{score.toFixed(3)}</span>
        ) : (
          <span className="text-[#6e7681] italic">—</span>
        )}
      </div>
      {windowSize && (
        <div className="text-[#8b949e] text-[12px]">Window: {windowSize}d</div>
      )}
    </Panel>
  );
};

import React from 'react';
import { Panel } from './shared/Panel';
import type { VetoThresholdData } from '../hooks/useVetoThreshold';

interface VetoPanelProps {
  vetoData?: VetoThresholdData;
}

export const VetoPanel: React.FC<VetoPanelProps> = ({ vetoData }) => {
  const threshold = vetoData?.effectiveThreshold ?? null;
  const autoTune = vetoData?.autoTuneEnabled ?? null;
  const computedAt = vetoData?.computedAt ?? null;

  return (
    <Panel title="Veto Threshold">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">
        {threshold !== null ? threshold.toFixed(3) : <span className="text-[#6e7681] italic">—</span>}
      </div>
      <div className="text-[#8b949e] text-[12px]">
        Auto-tune:{' '}
        {autoTune !== null ? (
          <span
            className={`pill inline-block px-[8px] py-[2px] rounded-[12px] text-[11px] font-bold tracking-wide ${
              autoTune
                ? 'bg-[#0d4429] text-[#3fb950] border border-[#1a7f37]'
                : 'bg-[#21262d] text-[#8b949e] border border-[#30363d]'
            }`}
          >
            {autoTune ? 'ENABLED' : 'DISABLED'}
          </span>
        ) : (
          <span className="text-[#6e7681] italic">—</span>
        )}
      </div>
      {computedAt && (
        <div className="text-[11px] text-[#6e7681] mt-[4px]">
          Computed: {new Date(computedAt).toLocaleString()}
        </div>
      )}
    </Panel>
  );
};

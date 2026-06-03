import React from 'react';
import { Panel } from './shared/Panel';
import type { ResolutionsData } from '../hooks/useDigest';

interface ResolutionsPanelProps {
  resolutions?: ResolutionsData;
}

export const ResolutionsPanel: React.FC<ResolutionsPanelProps> = ({ resolutions }) => {
  if (!resolutions) return null;

  const { honorRate, total, honored, abandoned } = resolutions;

  const pct = (val: number | null): string => {
    if (val === null) return '—';
    return `${(val * 100).toFixed(1)}%`;
  };

  return (
    <>
      <div className="section-head text-[#8b949e] text-[11px] uppercase tracking-wider my-[20px] border-b border-[#21262d] pb-[4px]">
        Commitment Resolutions
      </div>
      <Panel title="Honor Rate">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">
        {pct(honorRate)}
      </div>
      <table className="w-full border-collapse mt-[8px]">
        <tbody>
          <tr>
            <td className="text-[#8b949e] text-[12px] pr-[10px] py-[2px] whitespace-nowrap">Total</td>
            <td className="text-[#e6edf3] text-[12px] text-right break-all">
              {total !== null ? total : <span className="text-[#6e7681] italic">—</span>}
            </td>
          </tr>
          <tr>
            <td className="text-[#8b949e] text-[12px] pr-[10px] py-[2px] whitespace-nowrap">Honored</td>
            <td className="text-[#e6edf3] text-[12px] text-right break-all">
              {honored !== null ? honored : <span className="text-[#6e7681] italic">—</span>}
            </td>
          </tr>
          <tr>
            <td className="text-[#8b949e] text-[12px] pr-[10px] py-[2px] whitespace-nowrap">Abandoned</td>
            <td className="text-[#e6edf3] text-[12px] text-right break-all">
              {abandoned !== null ? abandoned : <span className="text-[#6e7681] italic">—</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
    </>
  );
};

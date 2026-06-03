import React from 'react';
import { Panel } from './shared/Panel';
import type { PatternsData } from '../hooks/useDigest';

interface PatternsPanelProps {
  patterns?: PatternsData;
}

export const PatternsPanel: React.FC<PatternsPanelProps> = ({ patterns }) => {
  const recurring = patterns?.recurringCount ?? null;
  const total = patterns?.totalMistakes ?? null;

  return (
    <Panel title="Mistake Patterns">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">
        {recurring !== null ? recurring : <span className="text-[#6e7681] italic">—</span>}
      </div>
      <div className="text-[#8b949e] text-[12px]">Recurring patterns</div>
      <table className="w-full border-collapse mt-[8px]">
        <tbody>
          <tr>
            <td className="text-[#8b949e] text-[12px] pr-[10px] py-[2px] whitespace-nowrap">Total mistakes</td>
            <td className="text-[#e6edf3] text-[12px] text-right break-all">
              {total !== null ? total : <span className="text-[#6e7681] italic">—</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
};

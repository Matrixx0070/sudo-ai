import React from 'react';
import { Panel } from './shared/Panel';
import type { CommitmentsData } from '../hooks/useDigest';

interface CommitmentsPanelProps {
  commitments?: CommitmentsData;
}

export const CommitmentsPanel: React.FC<CommitmentsPanelProps> = ({ commitments }) => {
  const expiring = commitments?.expiring ?? null;
  const expired = commitments?.expired ?? null;

  return (
    <Panel title="Commitments">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">
        {expiring !== null ? expiring : <span className="text-[#6e7681] italic">—</span>}
      </div>
      <div className="text-[#8b949e] text-[12px]">Expiring soon</div>
      <table className="w-full border-collapse mt-[8px]">
        <tbody>
          <tr>
            <td className="text-[#8b949e] text-[12px] pr-[10px] py-[2px] whitespace-nowrap">Expired</td>
            <td className="text-[#e6edf3] text-[12px] text-right break-all">
              {expired !== null ? expired : <span className="text-[#6e7681] italic">—</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
};

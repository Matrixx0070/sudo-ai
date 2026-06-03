import React from 'react';
import { Panel } from './shared/Panel';
import type { DiagnosticsData } from '../hooks/useDigest';

interface DiagnosticsPanelProps {
  diagnostics?: DiagnosticsData;
}

export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({ diagnostics }) => {
  const total = diagnostics?.totalEventsScanned ?? null;
  const corrCount = diagnostics?.correlationCount ?? null;

  return (
    <Panel title="Cross-Signal Diagnostics">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">
        {total !== null ? total : <span className="text-[#6e7681] italic">—</span>}
      </div>
      <div className="text-[#8b949e] text-[12px]">Events scanned</div>
      <table className="w-full border-collapse mt-[8px]">
        <tbody>
          <tr>
            <td className="text-[#8b949e] text-[12px] pr-[10px] py-[2px] whitespace-nowrap">Correlations</td>
            <td className="text-[#e6edf3] text-[12px] text-right break-all">
              {corrCount !== null ? corrCount : <span className="text-[#6e7681] italic">—</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
};

import React from 'react';
import { Panel } from './shared/Panel';
import type { CalibrationData } from '../hooks/useDigest';

interface CalibrationPanelProps {
  calibration?: CalibrationData;
}

export const CalibrationPanel: React.FC<CalibrationPanelProps> = ({ calibration }) => {
  const brierScore = calibration?.brierScore ?? null;
  const samples = calibration?.totalSamples ?? null;

  let brierClass = '';
  if (brierScore !== null) {
    brierClass = brierScore < 0.15
      ? 'bg-[#0d4429] text-[#3fb950] border border-[#1a7f37]'
      : brierScore < 0.25
      ? 'bg-[#3d2900] text-[#d29922] border border-[#9e6a03]'
      : 'bg-[#3d0000] text-[#f85149] border border-[#b62324]';
  }

  return (
    <Panel title="Brier Score (Calibration)">
      <div className="text-[#e6edf3] text-[22px] font-bold mb-[4px] break-all">
        {brierScore !== null ? (
          <span className={`pill inline-block px-[8px] py-[2px] rounded-[12px] text-[11px] font-bold tracking-wide ${brierClass}`}>
            {(brierScore * 100).toFixed(1)}%
          </span>
        ) : (
          <span className="text-[#6e7681] italic">—</span>
        )}
      </div>
      <div className="text-[#8b949e] text-[12px]">
        Samples:{' '}
        {samples !== null ? (
          <span className="text-[#e6edf3]">{samples}</span>
        ) : (
          <span className="text-[#6e7681] italic">—</span>
        )}
      </div>
      <div className="text-[11px] text-[#6e7681] mt-[4px]">Lower is better</div>
    </Panel>
  );
};

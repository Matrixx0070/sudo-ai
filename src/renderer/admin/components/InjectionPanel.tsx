import React from 'react';
import { Panel } from './shared/Panel';
import type { InjectionData } from '../hooks/useDigest';

interface InjectionPanelProps {
  injection?: InjectionData;
}

export const InjectionPanel: React.FC<InjectionPanelProps> = ({ injection }) => {
  if (!injection) {
    return (
      <Panel title="Injection Detections" wide>
        <div className="text-[#6e7681] italic">No data</div>
      </Panel>
    );
  }

  const total = injection.total ?? null;
  const byKind = injection.byKind || {};
  const kinds = Object.keys(byKind);

  return (
    <Panel title={`Injection Detections — Total: ${total !== null ? total : '—'}`} wide>
      {kinds.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-[6px] mt-[8px]">
          {kinds.map((kind) => (
            <div
              key={kind}
              className="bg-[#21262d] rounded-[4px] px-[6px] py-[10px] flex justify-between items-center"
            >
              <span
                className="text-[11px] text-[#8b949e] overflow-hidden text-ellipsis whitespace-nowrap mr-[8px]"
                title={kind}
              >
                {kind}
              </span>
              <span className="text-[13px] text-[#e6edf3] font-bold flex-shrink-0">
                {byKind[kind]}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[#6e7681] italic">No injection records</div>
      )}
    </Panel>
  );
};

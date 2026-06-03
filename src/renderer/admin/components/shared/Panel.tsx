import React from 'react';

interface PanelProps {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}

export const Panel: React.FC<PanelProps> = ({ title, children, wide = false }) => {
  const baseClasses = wide
    ? 'wide-panel bg-[#161b22] border border-[#30363d] rounded-md p-[14px] mb-[12px]'
    : 'panel bg-[#161b22] border border-[#30363d] rounded-md p-[14px]';

  return (
    <div className={baseClasses}>
      <div className="panel-title text-[#8b949e] text-[11px] uppercase tracking-wider mb-[10px]">
        {title}
      </div>
      {children}
    </div>
  );
};

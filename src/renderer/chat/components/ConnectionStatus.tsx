import React from 'react';

interface ConnectionStatusProps {
  connected: boolean;
}

export function ConnectionStatus({ connected }: ConnectionStatusProps) {
  return (
    <div className="ml-auto flex items-center gap-1.5 text-xs">
      <div
        className={`w-2 h-2 rounded-full ${
          connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'
        }`}
      />
      <span className={connected ? 'text-emerald-500' : 'text-gray-400'}>
        {connected ? 'Online' : 'Reconnecting...'}
      </span>
    </div>
  );
}

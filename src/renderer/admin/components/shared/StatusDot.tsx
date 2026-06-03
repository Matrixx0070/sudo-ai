import React from 'react';

type StatusType = 'ok' | 'loading' | 'error' | 'degraded';

interface StatusDotProps {
  status?: StatusType;
}

export const StatusDot: React.FC<StatusDotProps> = ({ status = 'loading' }) => {
  const getClass = () => {
    switch (status) {
      case 'ok':
        return 'dot';
      case 'error':
        return 'dot dot-red';
      case 'degraded':
        return 'dot dot-yellow';
      default:
        return 'dot dot-grey';
    }
  };

  return <span className={getClass()} />;
};

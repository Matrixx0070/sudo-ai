import React from 'react';

interface ErrorBannerProps {
  errors: string[];
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({ errors }) => {
  if (errors.length === 0) return null;

  return (
    <div
      id="error-banner"
      className="text-[#f85149] text-[12px] mt-[8px]"
      style={{ display: 'block' }}
    >
      {errors.join('; ')}
    </div>
  );
};

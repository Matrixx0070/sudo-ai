import React from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';

export function BackButton(): React.ReactElement | null {
  const cameraMode = useOfficeStore((s) => s.cameraMode);
  const resetCamera = useOfficeStore((s) => s.resetCamera);

  if (cameraMode === 'overview') return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-40"
      aria-hidden="false"
    >
      <button
        type="button"
        onClick={resetCamera}
        className="pointer-events-auto absolute left-4 top-4 flex items-center gap-2 rounded-lg bg-gray-800/80 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm transition-colors hover:bg-gray-700/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label="Back to overview"
      >
        <span aria-hidden="true">&#8592;</span>
        Back
      </button>
    </div>
  );
}

export default BackButton;

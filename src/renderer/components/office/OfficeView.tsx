/**
 * OfficeView
 *
 * Top-level office view. Renders the MissionControl full-screen dashboard
 * together with the headless DramaEngine that drives ambient agent events.
 */

import React, { useEffect } from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import { useOfficeWebSocket } from '@renderer/hooks/useOfficeWebSocket.js';
import MissionControl from './MissionControl.js';
import { DramaEngine } from './drama/DramaEngine.js';

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function OfficeView(): React.ReactElement {
  // Establish WebSocket connection for live metrics / real agent events
  useOfficeWebSocket();

  // ESC resets agent selection (store camera mode → overview)
  const resetCamera = useOfficeStore((s) => s.resetCamera);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        resetCamera();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resetCamera]);

  return (
    <div className="relative w-full h-full" role="main" aria-label="SUDO-AI Mission Control">
      <MissionControl />
      <DramaEngine />
    </div>
  );
}

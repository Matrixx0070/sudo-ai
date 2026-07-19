import React from 'react';

/**
 * BO11/S13 — live working-state row for the web chat, mirroring OpenClaw's
 * `⠦ noodling… • Ns → running • Ns → streaming • Ns`. The server sends a `phase`
 * frame carrying the label + an `elapsedSec` baseline; this component ticks the
 * seconds locally each second so the counter stays live without frame spam.
 */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface LivePhaseProps {
  phase: 'waiting' | 'running' | 'streaming';
  label: string;
  /** Server-provided elapsed baseline (seconds) at the moment the frame was sent. */
  elapsedSec: number;
}

export function LivePhase({ phase, label, elapsedSec }: LivePhaseProps) {
  // Local live counter: start from the server baseline and tick up each second.
  const [secs, setSecs] = React.useState(elapsedSec);
  const [tick, setTick] = React.useState(0);
  const baseRef = React.useRef({ base: elapsedSec, at: Date.now() });

  // Re-anchor whenever the server pushes a new phase/baseline.
  React.useEffect(() => {
    baseRef.current = { base: elapsedSec, at: Date.now() };
    setSecs(elapsedSec);
  }, [phase, elapsedSec]);

  React.useEffect(() => {
    const id = setInterval(() => {
      const { base, at } = baseRef.current;
      setSecs(base + Math.floor((Date.now() - at) / 1000));
      setTick((t) => (t + 1) % SPINNER.length);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs text-gray-400" data-testid="live-phase" data-phase={phase}>
      <span className="text-blue-400" aria-hidden>{SPINNER[tick]}</span>
      <span>{label}</span>
      <span className="text-gray-500">• {secs}s</span>
    </div>
  );
}

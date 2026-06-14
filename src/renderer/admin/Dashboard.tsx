import React, { useEffect, useState } from 'react';
import { useAuthToken } from './hooks/useAuthToken';
import { useDigest } from './hooks/useDigest';
import { useVetoThreshold } from './hooks/useVetoThreshold';
import { StatusDot } from './components/shared/StatusDot';
import { ErrorBanner } from './components/shared/ErrorBanner';
import { AlignmentPanel } from './components/AlignmentPanel';
import { TrustPanel } from './components/TrustPanel';
import { CalibrationPanel } from './components/CalibrationPanel';
import { CommitmentsPanel } from './components/CommitmentsPanel';
import { PatternsPanel } from './components/PatternsPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { VetoPanel } from './components/VetoPanel';
import { InjectionPanel } from './components/InjectionPanel';
import { ReanchorPanel } from './components/ReanchorPanel';
import { ResolutionsPanel } from './components/ResolutionsPanel';
import { FleetPanel } from './components/FleetPanel';

type StatusType = 'ok' | 'loading' | 'error' | 'degraded';

export const Dashboard: React.FC = () => {
  const token = useAuthToken();
  const { data: digestData, loading: digestLoading, error: digestError, refresh: refreshDigest } = useDigest(token);
  const { data: vetoData, loading: vetoLoading, error: vetoError, refresh: refreshVeto } = useVetoThreshold(token);

  const [status, setStatus] = useState<StatusType>('loading');
  const [statusText, setStatusText] = useState<string>('Loading…');
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [countdownSec, setCountdownSec] = useState<number>(30);
  const [errors, setErrors] = useState<string[]>([]);

  // Copy digest to clipboard
  const copyDigest = () => {
    if (digestData && navigator.clipboard) {
      navigator.clipboard.writeText(JSON.stringify(digestData, null, 2)).catch(() => {
        // Fallback not implemented for brevity
      });
    }
  };

  // Refresh both endpoints
  const refresh = async () => {
    setStatus('loading');
    setStatusText('Loading…');
    setErrors([]);

    const errorsList: string[] = [];

    try {
      await refreshDigest();
    } catch (e) {
      errorsList.push(`digest: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
    try {
      await refreshVeto();
    } catch (e) {
      errorsList.push(`veto: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }

    if (errorsList.length > 0) {
      setStatus('error');
      setStatusText(errorsList.join('; '));
      setErrors(errorsList);
    } else {
      setStatus('ok');
      setStatusText('Connected');
    }
    setLastUpdated(new Date().toLocaleTimeString());
    resetCountdown();
  };

  const resetCountdown = () => {
    setCountdownSec(30);
  };

  // Countdown timer
  useEffect(() => {
    if (status === 'loading') return;

    const interval = setInterval(() => {
      setCountdownSec((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          refresh();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [status]);

  // Initial load
  useEffect(() => {
    if (token) {
      refresh();
    } else {
      setStatus('error');
      setStatusText('No admin token');
    }
  }, [token]);

  // Update status based on loading states
  useEffect(() => {
    if (!token) {
      setStatus('error');
      setStatusText('No admin token');
      setErrors([]);
      return;
    }
    if (digestLoading || vetoLoading) {
      setStatus('loading');
      setStatusText('Loading…');
      return;
    }
    if (digestError || vetoError) {
      const errorsList = [
        digestError && `digest: ${digestError}`,
        vetoError && `veto: ${vetoError}`,
      ].filter(Boolean) as string[];
      setStatus('error');
      setStatusText(errorsList.join('; '));
      setErrors(errorsList);
      return;
    }
    setStatus('ok');
    setStatusText('Connected');
    setErrors([]);
  }, [token, digestLoading, vetoLoading, digestError, vetoError]);

  if (!token) {
    return (
      <div className="bg-[#0d1117] text-[#c9d1d9] font-['Courier New',Courier,monospace] text-[14px] leading-[1.5] p-[16px] min-h-screen">
        <div className="mb-[20px]">
          <h1 className="text-[#f0f6fc] text-[20px] mb-[4px] tracking-wide">SUDO-AI Alignment Dashboard</h1>
          <div className="text-[#8b949e] text-[12px] mb-[20px]">Wave 8B — admin telemetry</div>
        </div>
        <div className="panel bg-[#161b22] border border-[#f85149] rounded-md p-[14px]">
          <div className="panel-title text-[#f85149] text-[11px] uppercase tracking-wider mb-[10px]">
            No admin token
          </div>
          <div className="text-[#8b949e] text-[12px] mt-[8px]">
            Supply token via URL query:{' '}
            <code className="bg-[#21262d] px-[4px] py-[2px] rounded">?token=YOUR_TOKEN</code>
            <br />
            It will be saved to localStorage for future loads.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#0d1117] text-[#c9d1d9] font-['Courier New',Courier,monospace] text-[14px] leading-[1.5] p-[16px] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-[8px] mb-[20px]">
        <div>
          <h1 className="text-[#f0f6fc] text-[20px] mb-[4px] tracking-wide">SUDO-AI Alignment Dashboard</h1>
          <div className="text-[#8b949e] text-[12px]">Wave 8B — admin telemetry</div>
        </div>
        <div className="flex gap-[8px] flex-wrap">
          <button
            onClick={refresh}
            className="bg-[#21262d] text-[#c9d1d9] border border-[#30363d] rounded-md px-[14px] py-[6px] font-inherit text-[12px] cursor-pointer hover:bg-[#30363d] hover:text-[#e6edf3] active:bg-[#3d444d]"
          >
            Refresh
          </button>
          <button
            onClick={copyDigest}
            className="bg-[#21262d] text-[#c9d1d9] border border-[#30363d] rounded-md px-[14px] py-[6px] font-inherit text-[12px] cursor-pointer hover:bg-[#30363d] hover:text-[#e6edf3] active:bg-[#3d444d]"
          >
            Copy digest JSON
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-[12px] text-[12px] text-[#8b949e] flex-wrap mb-[8px]">
        <span>
          <StatusDot status={status} />{' '}
          <span id="status-text">{statusText}</span>
        </span>
        <span id="last-updated">{lastUpdated && `Updated: ${lastUpdated}`}</span>
        <span id="poll-countdown">Next refresh in {countdownSec}s</span>
      </div>

      {/* Error banner */}
      <ErrorBanner errors={errors} />

      {/* Dashboard grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[12px] mt-[16px]">
        <AlignmentPanel alignment={digestData?.alignment} />
        <TrustPanel trust={digestData?.trust} />
        <CalibrationPanel calibration={digestData?.calibration} />
        <CommitmentsPanel commitments={digestData?.commitments} />
        <PatternsPanel patterns={digestData?.patterns} />
        <DiagnosticsPanel diagnostics={digestData?.diagnostics} />
        <VetoPanel vetoData={vetoData ?? undefined} />
      </div>

      {/* Section header */}
      <div className="text-[#8b949e] text-[11px] uppercase tracking-wider my-[20px] border-b border-[#21262d] pb-[4px]">
        Injection &amp; Re-Anchor Analysis
      </div>

      <InjectionPanel injection={digestData?.injection} />
      <ReanchorPanel reanchor={digestData?.reanchor} />

      {/* Resolutions */}
      {digestData?.resolutions && <ResolutionsPanel resolutions={digestData.resolutions} />}

      {/* Section header — Fleet (gap #28c slice 3) */}
      <div className="text-[#8b949e] text-[11px] uppercase tracking-wider my-[20px] border-b border-[#21262d] pb-[4px]">
        Fleet
      </div>

      <FleetPanel token={token} />
    </div>
  );
};

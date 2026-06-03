import { useCallback, useEffect, useState } from 'react';

export interface VetoThresholdData {
  effectiveThreshold: number | null;
  autoTuneEnabled: boolean | null;
  computedAt?: string;
}

export interface VetoThresholdResponse {
  data?: VetoThresholdData;
}

interface UseVetoThresholdResult {
  data: VetoThresholdData | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useVetoThreshold(token: string): UseVetoThresholdResult {
  const [data, setData] = useState<VetoThresholdData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchThreshold = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/v1/admin/veto/threshold', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json: VetoThresholdResponse = await response.json();
      setData(json.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchThreshold();
    } else {
      setLoading(false);
      setError('No admin token');
    }
  }, [fetchThreshold, token]);

  return { data, loading, error, refresh: fetchThreshold };
}

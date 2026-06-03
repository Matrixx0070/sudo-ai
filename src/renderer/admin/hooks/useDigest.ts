import { useCallback, useEffect, useState } from 'react';

export interface AlignmentData {
  score: number | null;
  level: 'GREEN' | 'YELLOW' | 'RED' | null;
  diagnosis?: string;
}

export interface TrustData {
  tier: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  score: number | null;
  windowSizeDays?: number;
}

export interface CalibrationData {
  brierScore: number | null;
  totalSamples: number | null;
}

export interface CommitmentsData {
  expiring: number | null;
  expired: number | null;
}

export interface PatternsData {
  recurringCount: number | null;
  totalMistakes: number | null;
}

export interface DiagnosticsData {
  totalEventsScanned: number | null;
  correlationCount: number | null;
}

export interface InjectionData {
  total: number | null;
  byKind: Record<string, number>;
}

export interface ReanchorData {
  total: number | null;
  byTrigger: Record<string, number>;
}

export interface ResolutionsData {
  honorRate: number | null;
  total: number | null;
  honored: number | null;
  abandoned: number | null;
}

export interface DigestData {
  alignment?: AlignmentData;
  trust?: TrustData;
  calibration?: CalibrationData;
  commitments?: CommitmentsData;
  patterns?: PatternsData;
  diagnostics?: DiagnosticsData;
  injection?: InjectionData;
  reanchor?: ReanchorData;
  resolutions?: ResolutionsData;
}

export interface DigestResponse {
  data?: DigestData;
}

interface UseDigestResult {
  data: DigestData | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useDigest(token: string): UseDigestResult {
  const [data, setData] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDigest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/v1/admin/digest?window=7', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json: DigestResponse = await response.json();
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
      fetchDigest();
    } else {
      setLoading(false);
      setError('No admin token');
    }
  }, [fetchDigest, token]);

  return { data, loading, error, refresh: fetchDigest };
}

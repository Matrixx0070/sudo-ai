import { useCallback, useEffect, useState } from 'react';

export interface CanvasStateEntry {
  sessionId: string;
  updatedAt: string;
  title?: string;
  componentCount: number;
  components: Array<Record<string, unknown>>;
}

interface CanvasStatesResponse {
  ok?: boolean;
  data?: CanvasStateEntry[];
}

interface UseCanvasStatesResult {
  data: CanvasStateEntry[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Poll GET /v1/admin/canvas — the interactive UI the agent is rendering to sessions. */
export function useCanvasStates(token: string): UseCanvasStatesResult {
  const [data, setData] = useState<CanvasStateEntry[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/v1/admin/canvas?limit=20', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json: CanvasStatesResponse = await response.json();
      setData(Array.isArray(json.data) ? json.data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchStates();
    } else {
      setLoading(false);
      setError('No admin token');
    }
  }, [fetchStates, token]);

  return { data, loading, error, refresh: fetchStates };
}

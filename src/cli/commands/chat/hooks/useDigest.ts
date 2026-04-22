/**
 * @file useDigest.ts — Polls /v1/admin/digest every 30s.
 * Initial state: 8 amber dots. On error, keeps previous value.
 */

import { useState, useEffect, useRef } from 'react';

export interface DigestSignal {
  name: 'veto' | 'trust' | 'commits' | 'epistemic' | 'calibration' | 'discordance' | 'reanchor' | 'brier';
  color: '#7acc7a' | '#e8b860' | '#dd6666';
  value: number;
}

export interface DigestData {
  signals: DigestSignal[];
  overall: 'GREEN' | 'AMBER' | 'RED';
  raw: unknown;
}

const SIGNAL_NAMES: DigestSignal['name'][] = [
  'veto', 'trust', 'commits', 'epistemic',
  'calibration', 'discordance', 'reanchor', 'brier',
];

export const INITIAL_DIGEST: DigestData = {
  signals: SIGNAL_NAMES.map(name => ({
    name,
    color: '#e8b860',
    value: 0.5,
  })),
  overall: 'AMBER',
  raw: null,
};

function scoreToColor(score: number): '#7acc7a' | '#e8b860' | '#dd6666' {
  if (score >= 0.7) return '#7acc7a';
  if (score >= 0.4) return '#e8b860';
  return '#dd6666';
}

function parseDigest(data: unknown): DigestData {
  if (typeof data !== 'object' || data === null) return INITIAL_DIGEST;
  const d = data as Record<string, unknown>;

  // Map signals from API response
  const rawSignals = Array.isArray(d['signals']) ? d['signals'] : [];
  const signals: DigestSignal[] = SIGNAL_NAMES.map(name => {
    const found = rawSignals.find(
      (s: unknown) => typeof s === 'object' && s !== null &&
        (s as Record<string, unknown>)['name'] === name
    ) as Record<string, unknown> | undefined;

    const score = found ? Number(found['score'] ?? 0.5) : 0.5;
    return { name, color: scoreToColor(score), value: score };
  });

  // Determine overall
  const overallRaw = typeof d['overall'] === 'string' ? d['overall'].toUpperCase() : 'AMBER';
  const overall = (overallRaw === 'GREEN' || overallRaw === 'RED' || overallRaw === 'AMBER')
    ? (overallRaw as 'GREEN' | 'AMBER' | 'RED')
    : 'AMBER';

  return { signals, overall, raw: data };
}

export function useDigest(baseUrl: string): DigestData {
  const [digest, setDigest] = useState<DigestData>(INITIAL_DIGEST);
  const prevRef = useRef<DigestData>(INITIAL_DIGEST);

  useEffect(() => {
    const key = process.env['SUDOAPI_KEY'] ?? '';
    const url = `${baseUrl}/v1/admin/digest`;

    const fetchDigest = (): void => {
      fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
      })
        .then(res => {
          if (!res.ok) return;
          return res.json();
        })
        .then((data: unknown) => {
          if (data == null) return;
          const parsed = parseDigest(data);
          prevRef.current = parsed;
          setDigest(parsed);
        })
        .catch(() => {
          // Keep previous value on error
          setDigest(prevRef.current);
        });
    };

    fetchDigest();
    const id = setInterval(fetchDigest, 30_000);
    return () => { clearInterval(id); };
  }, [baseUrl]);

  return digest;
}

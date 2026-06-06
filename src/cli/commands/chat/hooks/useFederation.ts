/**
 * @file useFederation.ts — Polls /v1/federation/peers every 30s.
 * On error: { peers: [], count: 0 }.
 */

import { useState, useEffect } from 'react';

export interface Peer {
  id: string;
  url: string;
  status: 'connected' | 'degraded' | 'offline';
}

export interface FederationData {
  peers: Peer[];
  count: number;
}

const EMPTY: FederationData = { peers: [], count: 0 };

function parsePeers(data: unknown): FederationData {
  if (typeof data !== 'object' || data === null) return EMPTY;
  const d = data as Record<string, unknown>;
  const rawPeers = Array.isArray(d['peers']) ? d['peers'] : [];

  const peers: Peer[] = rawPeers
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map(p => {
      const status = p['status'];
      const safeStatus: Peer['status'] =
        status === 'connected' || status === 'degraded' || status === 'offline'
          ? status
          : 'offline';
      return {
        id: String(p['id'] ?? ''),
        url: String(p['url'] ?? ''),
        status: safeStatus,
      };
    });

  return { peers, count: peers.length };
}

export function useFederation(baseUrl: string): FederationData {
  const [federation, setFederation] = useState<FederationData>(EMPTY);

  useEffect(() => {
    const key = process.env['GATEWAY_TOKEN'] ?? '';
    const url = `${baseUrl}/v1/federation/peers`;

    const fetchPeers = (): void => {
      fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
      })
        .then(res => {
          if (!res.ok) return;
          return res.json();
        })
        .then((data: unknown) => {
          if (data == null) return;
          setFederation(parsePeers(data));
        })
        .catch(() => {
          setFederation(EMPTY);
        });
    };

    fetchPeers();
    const id = setInterval(fetchPeers, 30_000);
    return () => { clearInterval(id); };
  }, [baseUrl]);

  return federation;
}

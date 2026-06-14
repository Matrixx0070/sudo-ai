/**
 * @file src/tui/fleetview/app.tsx
 * @description Ink App component for the FleetView TUI (gap #25 slice 2).
 *
 * Reads the dashboard's `/api/agents/live` endpoint on a fixed interval and
 * renders a small terminal panel: header, summary line, per-agent rows, and a
 * status footer. Press `q` or Ctrl+C to quit.
 *
 * All side-effects live in useEffect; rendering is pure. The fetcher + format
 * helpers are imported from their own modules so the testable surface stays
 * outside ink.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { fetchLiveAgents, type FetchResult, type TuiConfig } from './fetcher.js';
import { clipTask, formatElapsed, shortId, summaryLine } from './format.js';
import type { LiveAgentsData } from '../../core/dashboard/dashboard-types.js';

interface AppProps {
  /**
   * Effective TUI runtime config. Must be a STABLE reference for the lifetime
   * of the App instance — the polling useEffect re-fires on every change and
   * would start a duplicate interval if the parent passes a fresh object on
   * each render. Use `readConfigFromEnv()` once at the top of main() and pass
   * the result through; never inline `config={{ ...readConfigFromEnv() }}`.
   */
  config: TuiConfig;
}

interface State {
  /** Last successful snapshot — keep showing it while a fetch is in-flight. */
  data: LiveAgentsData | null;
  /** Last error message; cleared on next success. */
  error: string | null;
  /** Monotonic counter for the footer status line. */
  ticks: number;
  /** ISO timestamp of last successful fetch. */
  lastSuccessAt: string | null;
}

export function App({ config }: AppProps): React.JSX.Element {
  const app = useApp();
  const [state, setState] = useState<State>({
    data: null,
    error: null,
    ticks: 0,
    lastSuccessAt: null,
  });

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      app.exit();
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      const result: FetchResult = await fetchLiveAgents(config);
      if (cancelled) return;
      setState((prev) => ({
        ...prev,
        ticks: prev.ticks + 1,
        ...(result.ok
          ? { data: result.data, error: null, lastSuccessAt: new Date().toISOString() }
          : { error: result.error }),
      }));
    }

    void tick();
    const handle = setInterval(() => {
      void tick();
    }, config.pollMs);

    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [config]);

  const data = state.data;
  const idleCount = data ? data.spawned.filter((a) => a.idle).length : 0;
  const summary = data
    ? summaryLine({
        slotsUsed: data.slotsUsed,
        slotsMax: data.slotsMax,
        queueWaiting: data.queueWaiting,
        idleCount,
      })
    : 'awaiting first snapshot…';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          SUDO-AI · FleetView
        </Text>
        <Text dimColor>
          {'  '}
          {config.host}:{config.port} · poll {config.pollMs}ms · press q to quit
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="green">{summary}</Text>
      </Box>
      {state.error ? (
        <Box marginTop={1}>
          <Text color="red">error: {state.error}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {data && data.spawned.length === 0 ? (
          <Text dimColor>no live agents</Text>
        ) : null}
        {data
          ? data.spawned.map((a) => (
              <Box key={a.id} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color="cyan">{shortId(a.id, 8)}</Text>
                  {a.idle ? <Text color="yellow"> [IDLE]</Text> : null}
                  <Text dimColor>
                    {'  elapsed '}
                    {formatElapsed(a.elapsedMs)}
                  </Text>
                  <Text dimColor>
                    {'  heartbeat '}
                    {formatElapsed(a.sinceHeartbeatMs)}
                    {' ago'}
                  </Text>
                </Box>
                <Box>
                  <Text>{clipTask(a.task, 100)}</Text>
                </Box>
              </Box>
            ))
          : null}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          tick {state.ticks}
          {state.lastSuccessAt ? ` · last ok ${new Date(state.lastSuccessAt).toLocaleTimeString()}` : ''}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * @file tests/llm/grok-warm-browser.test.ts
 * @description GWV6 — WarmGrokBrowser manager, with mocked spawn/network (no real
 * browser, no net). Covers: adopt a running CF-clear browser, cold-spawn + wait
 * for the real grok app title (not the "Just a moment" interstitial), and the
 * no-profile escalation.
 */
import { describe, it, expect } from 'vitest';
import { WarmGrokBrowser, GrokWarmBrowserError } from '../../src/llm/grok-warm-browser.js';

type Json = (url: string) => Promise<unknown>;

function harness(fetchJson: Json, profileDir = '.', onSpawn?: () => void) {
  let t = 0;
  const spawned: string[][] = [];
  const w = new WarmGrokBrowser({
    profileDir,
    port: 9223,
    display: ':99',
    deps: {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      spawnProcess: (_cmd, args) => {
        spawned.push(args);
        onSpawn?.();
        return { unref: () => {} };
      },
      fetchJson,
    },
  });
  return { w, spawned };
}

const readyTab = [{ type: 'page', url: 'https://grok.com/imagine', title: 'Imagine - Grok' }];
const cfTab = [{ type: 'page', url: 'https://grok.com/imagine', title: 'Just a moment...' }];

describe('WarmGrokBrowser', () => {
  it('adopts an already-running CF-clear browser without spawning', async () => {
    const { w, spawned } = harness(async (url) =>
      url.endsWith('/json/version') ? { Browser: 'x' } : readyTab,
    );
    expect(await w.ensureRunning()).toBe('http://127.0.0.1:9223');
    expect(spawned).toHaveLength(0);
  });

  it('cold-spawns and waits for the real grok app title (past the CF interstitial)', async () => {
    let spawnedFlag = false;
    let jsonCalls = 0;
    const { w, spawned } = harness(
      async (url) => {
        if (url.endsWith('/json/version')) {
          if (!spawnedFlag) throw new Error('down');
          return {};
        }
        jsonCalls++;
        // Ready only after a couple of polls post-spawn; before that it is the
        // Cloudflare interstitial, which must NOT read as ready.
        return spawnedFlag && jsonCalls >= 2 ? readyTab : cfTab;
      },
      '.',
      () => {
        spawnedFlag = true;
      },
    );
    expect(await w.ensureRunning()).toBe('http://127.0.0.1:9223');
    expect(spawned).toHaveLength(1);
  });

  it('escalates when there is no durable profile and none is running', async () => {
    const { w } = harness(
      async (url) => {
        if (url.endsWith('/json/version')) throw new Error('down');
        return cfTab;
      },
      '/nonexistent-grok-profile-xyz',
    );
    await expect(w.ensureRunning()).rejects.toBeInstanceOf(GrokWarmBrowserError);
  });
});

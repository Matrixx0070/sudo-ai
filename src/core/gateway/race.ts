/**
 * gateway/race.ts
 *
 * Race Engine — fires requests to 2-3 SUDOAPI models simultaneously and
 * streams the first successful response back to the HTTP client.
 *
 * The first model that starts returning tokens wins; all other in-flight
 * requests are aborted immediately.
 */

import type { ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { progress } from './progress.js';

const log = createLogger('gateway:race');

export interface RaceConfig {
  upstreamUrl: string;
  apiKey: string;
  onWin?: (model: string, racerIndex: number) => void;
}

/**
 * Race `models` against each other for the given request body.
 * The winning model's SSE stream is piped directly to `res`.
 *
 * @param body      - Stringified JSON of the chat completions request.
 * @param models    - Ordered list of model names to race.
 * @param res       - Node ServerResponse to stream the winner into.
 * @param sessionId - Used to emit progress events.
 * @param config    - Upstream URL, API key, and optional win callback.
 */
export async function raceProviders(
  body: string,
  models: readonly string[],
  res: ServerResponse,
  sessionId: string,
  config: RaceConfig,
): Promise<void> {
  if (models.length === 0) throw new TypeError('raceProviders: models must not be empty');

  const parsed = JSON.parse(body) as Record<string, unknown>;
  let won = false;
  const controllers: AbortController[] = [];

  progress.thinking(sessionId);

  const racePromises = models.map(async (model, i) => {
    const ctrl = new AbortController();
    controllers.push(ctrl);

    const raceBody = JSON.stringify({ ...parsed, model, stream: true });

    const response = await fetch(`${config.upstreamUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: raceBody,
      signal: ctrl.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${model}: HTTP ${response.status} — ${errText.replace(/[\n\r\x1b]/g, ' ').slice(0, 120)}`);
    }

    // If another racer already won while we were waiting for headers, abort self
    if (won) { ctrl.abort(); return; }

    // Claim the win
    won = true;
    controllers.forEach((c, j) => {
      if (j !== i) { try { c.abort(); } catch { /* ignore */ } }
    });

    log.info({ winner: model, racerIndex: i }, 'Race winner');
    config.onWin?.(model, i);
    progress.streaming(sessionId, 0, model);

    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Provider': model,
      });
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let tokenCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
        tokenCount++;

        // Detect tool_call markers in the SSE data
        if (chunk.includes('"tool_calls"') || chunk.includes('"function"')) {
          progress.toolCall(sessionId, 'tool', model);
        }

        // Emit streaming updates every 20 chunks (~periodic)
        if (tokenCount % 20 === 0) {
          progress.streaming(sessionId, tokenCount, model);
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
    log.debug({ model, chunks: tokenCount }, 'Race stream complete');
  });

  try {
    await Promise.any(racePromises);
  } catch (err) {
    if (!won) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'All race providers failed');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        error: { message: 'All race providers failed', type: 'gateway_error' },
      }));
    }
  }
}

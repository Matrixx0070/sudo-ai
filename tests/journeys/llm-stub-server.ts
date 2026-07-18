/**
 * @file tests/journeys/llm-stub-server.ts
 * @description GW-13 — scriptable mock LLM transport for scenario journeys.
 *
 * A tiny OpenAI-compatible HTTP server that the journey harness points
 * `LLM_BASE_URL` (or a direct fetch) at. It is *scriptable per model*: a caller
 * declares which model names return 5xx and which return a canned completion, so
 * a journey can drive the real GW-2 failover chain across a real HTTP round-trip
 * without any live provider. Every request is logged (model + ts) so a journey
 * can assert the ORDER models were tried (the cost-cliff: cheap tier before the
 * expensive no-cache escalation).
 *
 * Deliberately dependency-free (node:http only) so it works under vitest without
 * a build step, mirroring the other in-tree integration harnesses.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubModelBehavior {
  /** HTTP status to return for this model. 200 ⇒ canned reply; 5xx ⇒ failure. */
  status: number;
  /** Reply text for a 200. Defaults to `ok:<model>`. */
  reply?: string;
}

export interface StubRequest {
  model: string;
  atMs: number;
  body: unknown;
}

export interface LlmStub {
  /** Base URL, no trailing slash, e.g. http://127.0.0.1:54123 */
  baseUrl: string;
  /** Every chat/completions request, in arrival order. */
  requests: StubRequest[];
  /** Convenience: the model names tried, in order. */
  modelsTried(): string[];
  /** Replace the per-model behavior map at runtime. */
  setBehavior(map: Record<string, StubModelBehavior>): void;
  close(): Promise<void>;
}

/**
 * Start the stub. `behavior` maps a model name (exact match, or '*' fallback) to
 * its response. A model with no entry and no '*' fallback returns 200 `ok:<model>`.
 */
export async function startLlmStub(
  behavior: Record<string, StubModelBehavior> = {},
): Promise<LlmStub> {
  let behaviorMap = { ...behavior };
  const requests: StubRequest[] = [];

  const server: Server = createServer((req, res) => {
    if (!req.url || !req.url.includes('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let body: unknown = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      const model = String((body as { model?: unknown }).model ?? 'unknown');
      requests.push({ model, atMs: Date.now(), body });
      const b = behaviorMap[model] ?? behaviorMap['*'] ?? { status: 200 };
      if (b.status >= 200 && b.status < 300) {
        const reply = b.reply ?? `ok:${model}`;
        res.writeHead(b.status, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'stub-cmpl',
            object: 'chat.completion',
            model,
            choices: [
              { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
          }),
        );
      } else {
        res.writeHead(b.status, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: { message: `stub ${b.status} for ${model}`, type: 'stub_error' } }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    modelsTried: () => requests.map((r) => r.model),
    setBehavior: (map) => {
      behaviorMap = { ...map };
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * POST a one-shot chat completion to the stub. Returns `{ status, reply }`.
 * Throws only on a transport error; a 5xx is returned as `{ status }` so the
 * caller (a failover loop) can decide to hop.
 */
export async function callStub(
  baseUrl: string,
  model: string,
  prompt: string,
): Promise<{ status: number; reply: string | null }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  });
  if (res.status < 200 || res.status >= 300) {
    return { status: res.status, reply: null };
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { status: res.status, reply: json.choices?.[0]?.message?.content ?? null };
}

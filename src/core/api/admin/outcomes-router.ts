/**
 * @file outcomes-router.ts
 * @description REST route handlers for the SUDO-AI admin API.
 *
 * Three routers are exported:
 *
 *   createOutcomesRouter  — CRUD + summary for outcome records.
 *   createSteeringRouter  — POST /v1/steer to inject steering signals into
 *                           live sessions via a SteeringChannel.
 *
 * Each factory returns an async handler with the signature:
 *
 *   (req, res, path) => Promise<boolean>
 *
 * A return value of `true` means the request was handled and the caller must
 * not write to `res` again.  `false` means the path was not matched and the
 * next handler should be tried.
 *
 * Usage (inside http-server.ts or a similar dispatcher):
 * ```ts
 * const handleOutcomes = createOutcomesRouter({ query, record, summarize });
 * const handleSteering = createSteeringRouter(steeringChannel);
 *
 * const handled =
 *   (await handleOutcomes(req, res, pathname)) ||
 *   (await handleSteering(req, res, pathname));
 *
 * if (!handled) { res.writeHead(404); res.end(); }
 * ```
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Outcomes router
// ---------------------------------------------------------------------------

/**
 * Dependency bag for the outcomes router.
 * All three methods are provided by the OutcomesStore (or a compatible mock).
 */
export interface OutcomesRouterDeps {
  /**
   * Query outcome records.
   *
   * @param filter.type  - Optional outcome type filter (e.g. `'success'`).
   * @param filter.since - Optional ISO-8601 lower bound on `createdAt`.
   * @param filter.limit - Maximum number of records to return.
   */
  query: (filter: { type?: string; since?: string; limit?: number }) => object[];

  /**
   * Persist a new outcome entry.
   *
   * @param entry - Arbitrary outcome data object.
   * @returns     - The generated record ID.
   */
  record: (entry: object) => string;

  /**
   * Return a statistical summary of outcomes.
   *
   * @param since - Optional ISO-8601 lower bound; omit for all-time summary.
   */
  summarize: (since?: string) => object;
}

/**
 * Build a request handler for outcome endpoints.
 *
 * Handled routes:
 *   GET  /v1/outcomes         — list outcomes (supports ?type, ?since, ?limit)
 *   GET  /v1/outcomes/summary — aggregated summary
 *   POST /v1/outcomes         — record a new outcome (JSON body)
 */
export function createOutcomesRouter(deps: OutcomesRouterDeps) {
  return async function handleOutcomesRequest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<boolean> {
    // ------------------------------------------------------------------
    // GET /v1/outcomes — list with optional query-string filters
    // ------------------------------------------------------------------
    if (path === '/v1/outcomes' && req.method === 'GET') {
      // Parse query parameters from the raw URL (e.g. /v1/outcomes?limit=10)
      const rawUrl = req.url ?? '';
      const qStart = rawUrl.indexOf('?');
      const params = qStart !== -1
        ? new URLSearchParams(rawUrl.slice(qStart + 1))
        : new URLSearchParams();

      const filter: { type?: string; since?: string; limit?: number } = {};
      if (params.has('type'))  filter.type  = params.get('type')!;
      if (params.has('since')) filter.since = params.get('since')!;
      if (params.has('limit')) {
        const n = parseInt(params.get('limit')!, 10);
        if (!isNaN(n) && n > 0) filter.limit = n;
      }

      const results = deps.query(filter);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ outcomes: results }));
      return true;
    }

    // ------------------------------------------------------------------
    // GET /v1/outcomes/summary — aggregated statistics
    // ------------------------------------------------------------------
    if (path === '/v1/outcomes/summary' && req.method === 'GET') {
      const rawUrl = req.url ?? '';
      const qStart = rawUrl.indexOf('?');
      const params = qStart !== -1
        ? new URLSearchParams(rawUrl.slice(qStart + 1))
        : new URLSearchParams();

      const since = params.get('since') ?? undefined;
      const summary = deps.summarize(since);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
      return true;
    }

    // ------------------------------------------------------------------
    // POST /v1/outcomes — record a new outcome
    // ------------------------------------------------------------------
    if (path === '/v1/outcomes' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;

      let entry: object;
      try {
        entry = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return true;
      }

      const id = deps.record(entry);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return true;
    }

    return false; // Path not handled by this router
  };
}

// ---------------------------------------------------------------------------
// Steering router
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the object that receives steering signals.
 * The full SteeringChannel implementation lives elsewhere; this interface
 * keeps the router decoupled from that module.
 */
export interface SteeringChannelLike {
  /**
   * Inject a steering signal into an active session.
   *
   * @param sessionId - Target session.
   * @param signal    - Steering payload: `{ action, payload }`.
   */
  signal: (sessionId: string, signal: { action: string; payload: unknown }) => void;
}

/**
 * Build a request handler for the steering endpoint.
 *
 * Handled routes:
 *   POST /v1/steer — inject a steering signal into a live session
 *
 * Expected JSON body:
 * ```json
 * { "sessionId": "...", "action": "redirect", "payload": { ... } }
 * ```
 */
export function createSteeringRouter(steeringChannel: SteeringChannelLike) {
  return async function handleSteeringRequest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<boolean> {
    // ------------------------------------------------------------------
    // POST /v1/steer — inject a steering signal
    // ------------------------------------------------------------------
    if (path === '/v1/steer' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;

      let parsed: { sessionId?: unknown; action?: unknown; payload?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return true;
      }

      const { sessionId, action, payload } = parsed;

      if (typeof sessionId !== 'string' || typeof action !== 'string') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '`sessionId` (string) and `action` (string) are required' }));
        return true;
      }

      steeringChannel.signal(sessionId, { action, payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    return false; // Path not handled by this router
  };
}

/**
 * gateway/rpc-handlers.ts
 *
 * Builds the RPC method router: a Map from method name → handler function.
 *
 * Real wiring to sessionManager, toolRegistry, agentLoop, cronManager.
 *
 * Each handler receives the raw `params` value from the incoming RpcRequest
 * and returns a result that will be placed in RpcResponse.result.
 * Throwing an Error causes the caller (ws-server.ts) to respond with an
 * RpcResponse.error instead — handlers should throw for logical errors.
 *
 * Error policy:
 *   - Every handler wraps its body in try/catch.
 *   - On error, returns { error: err.message } (not throw) so the router
 *     can still produce a structured response with context.
 */

import type { RpcHandlerFn } from './rpc-types.js';
import type { WsServerDeps } from './ws-server.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('rpc-handlers');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a string field from an unknown params object; returns undefined if missing. */
function getString(params: unknown, key: string): string | undefined {
  if (params && typeof params === 'object') {
    const v = (params as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Router builder
// ---------------------------------------------------------------------------

/**
 * Build a Map of method name → async handler function.
 *
 * @param deps - Server-level dependencies injected at startup.
 */
export function buildRpcRouter(deps: WsServerDeps): Map<string, RpcHandlerFn> {
  const router = new Map<string, RpcHandlerFn>();

  // -------------------------------------------------------------------------
  // health — liveness/readiness check
  // -------------------------------------------------------------------------
  router.set('health', async (_params: unknown) => {
    log.debug('health called');
    return {
      status: 'ok',
      uptime: process.uptime(),
    };
  });

  // -------------------------------------------------------------------------
  // tools.catalog — list available tools with LLM-compatible schemas
  // -------------------------------------------------------------------------
  router.set('tools.catalog', async (_params: unknown) => {
    log.debug('tools.catalog called');
    try {
      const registry = deps.toolRegistry as { getSchemaForLLM?: () => object[] } | undefined;
      if (registry && typeof registry.getSchemaForLLM === 'function') {
        return registry.getSchemaForLLM();
      }
      log.warn('tools.catalog: toolRegistry.getSchemaForLLM not available');
      return [] as unknown[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'tools.catalog handler error');
      return { error: msg };
    }
  });

  // -------------------------------------------------------------------------
  // sessions.list — list active sessions
  // -------------------------------------------------------------------------
  router.set('sessions.list', async (_params: unknown) => {
    log.debug('sessions.list called');
    try {
      const sm = deps.sessionManager as { listActive?: () => Promise<unknown[]> } | undefined;
      if (sm && typeof sm.listActive === 'function') {
        return await sm.listActive();
      }
      log.warn('sessions.list: sessionManager.listActive not available');
      return [] as unknown[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'sessions.list handler error');
      return { error: msg };
    }
  });

  // -------------------------------------------------------------------------
  // sessions.send — alias for chat.send (REST parity)
  // -------------------------------------------------------------------------
  router.set('sessions.send', async (params: unknown) => {
    log.debug('sessions.send called');
    try {
      const sessionId = getString(params, 'sessionId');
      const message   = getString(params, 'message');

      if (!sessionId || !message) {
        return { error: 'sessions.send requires { sessionId: string, message: string }' };
      }

      const loop = deps.agentLoop as { run?: (sid: string, msg: string) => Promise<{ text: string; attachments: unknown[] }> } | undefined;
      if (!loop || typeof loop.run !== 'function') {
        return { error: 'agentLoop not available' };
      }

      const result = await loop.run(sessionId, message);
      log.info({ sessionId, textLen: result.text.length }, 'sessions.send completed');
      return { text: result.text, attachments: result.attachments };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'sessions.send handler error');
      return { error: msg };
    }
  });

  // -------------------------------------------------------------------------
  // chat.send — send a message and start an agent turn
  // -------------------------------------------------------------------------
  router.set('chat.send', async (params: unknown) => {
    log.debug('chat.send called');
    try {
      const sessionId = getString(params, 'sessionId');
      const message   = getString(params, 'message');

      if (!sessionId || !message) {
        return { error: 'chat.send requires { sessionId: string, message: string }' };
      }

      const loop = deps.agentLoop as { run?: (sid: string, msg: string) => Promise<{ text: string; attachments: unknown[] }> } | undefined;
      if (!loop || typeof loop.run !== 'function') {
        return { error: 'agentLoop not available' };
      }

      const result = await loop.run(sessionId, message);
      log.info({ sessionId, textLen: result.text.length }, 'chat.send completed');
      return { text: result.text, attachments: result.attachments };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'chat.send handler error');
      return { error: msg };
    }
  });

  // -------------------------------------------------------------------------
  // chat.abort — cancel an in-progress turn
  // AgentLoop has no public abort() method — return informational status.
  // -------------------------------------------------------------------------
  router.set('chat.abort', async (_params: unknown) => {
    log.debug('chat.abort called');
    return { status: 'abort not supported' };
  });

  // -------------------------------------------------------------------------
  // cron.add — schedule a recurring job
  // Params: { name: string, schedule: CronSchedule, message: string,
  //           sessionTarget?: 'main' | 'isolated' }
  // -------------------------------------------------------------------------
  router.set('cron.add', async (params: unknown) => {
    log.debug('cron.add called');
    try {
      if (!params || typeof params !== 'object') {
        return { error: 'cron.add requires a params object' };
      }
      const p = params as Record<string, unknown>;

      const name = p['name'];
      if (typeof name !== 'string' || name.length === 0) {
        return { error: 'cron.add requires { name: string }' };
      }

      const schedule = p['schedule'];
      if (!schedule || typeof schedule !== 'object') {
        return { error: 'cron.add requires { schedule: CronSchedule }' };
      }

      const message = p['message'];
      if (typeof message !== 'string' || message.length === 0) {
        return { error: 'cron.add requires { message: string }' };
      }

      const sessionTarget =
        p['sessionTarget'] === 'isolated' ? 'isolated' : ('main' as const);

      const cm = deps.cronManager as {
        addJob?: (job: {
          name: string;
          schedule: unknown;
          payload: { kind: 'agentTurn'; message: string };
          sessionTarget: 'main' | 'isolated';
          enabled: boolean;
          consecutiveErrors: number;
        }) => { id: string };
      } | undefined;

      if (!cm || typeof cm.addJob !== 'function') {
        return { error: 'cronManager not available' };
      }

      const job = cm.addJob({
        name,
        schedule,
        payload: { kind: 'agentTurn', message },
        sessionTarget,
        enabled: true,
        consecutiveErrors: 0,
      });

      log.info({ jobId: job.id, name }, 'cron.add completed');
      return { ok: true, id: job.id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'cron.add handler error');
      return { error: msg };
    }
  });

  // -------------------------------------------------------------------------
  // cron.list — list scheduled jobs
  // -------------------------------------------------------------------------
  router.set('cron.list', async (_params: unknown) => {
    log.debug('cron.list called');
    try {
      const cm = deps.cronManager as { listJobs?: () => unknown[] } | undefined;
      if (cm && typeof cm.listJobs === 'function') {
        return cm.listJobs();
      }
      log.warn('cron.list: cronManager.listJobs not available');
      return [] as unknown[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'cron.list handler error');
      return { error: msg };
    }
  });

  // -------------------------------------------------------------------------
  // cron.remove — cancel and delete a scheduled job
  // Params: { id: string }
  // -------------------------------------------------------------------------
  router.set('cron.remove', async (params: unknown) => {
    log.debug('cron.remove called');
    try {
      const id = getString(params, 'id');
      if (!id) {
        return { error: 'cron.remove requires { id: string }' };
      }

      const cm = deps.cronManager as { removeJob?: (id: string) => boolean } | undefined;
      if (!cm || typeof cm.removeJob !== 'function') {
        return { error: 'cronManager not available' };
      }

      const removed = cm.removeJob(id);
      log.info({ jobId: id, removed }, 'cron.remove completed');
      return { ok: removed };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'cron.remove handler error');
      return { error: msg };
    }
  });

  log.info({ methods: [...router.keys()] }, 'RPC router built');
  return router;
}

/**
 * OpenAI-compatible HTTP server for SUDO-AI.
 *
 * Drop-in replacement for the OpenAI Chat Completions API. Any client
 * that works with OpenAI can point its base URL at this server.
 *
 * Routes:
 *   POST  /v1/chat/completions   — chat completions (streaming + non-streaming)
 *   GET   /v1/models             — list available models
 *   GET   /health                — liveness probe
 *
 * Auth:   Bearer token via SUDO_AI_API_TOKEN env var (skipped if unset).
 * Rate:   60 req/min per client IP (configurable via constructor).
 *
 * Chat completion logic lives in handlers.ts to keep this file under 250 LOC.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { SudoError } from '../shared/errors.js';
import { RateLimiter } from './rate-limiter.js';
import {
  validateChatRequest,
  handleNonStreaming,
  handleStreaming,
} from './handlers.js';
import { createOutcomesRouter, createSteeringRouter } from './admin/outcomes-router.js';
import type { ChatCompletionRequest, ModelObject, ModelsListResponse } from './types.js';
import type { Brain } from '../brain/brain.js';
import type { OutcomesRouterDeps, SteeringChannelLike } from './admin/outcomes-router.js';

const log = createLogger('api:http-server');

const SUDO_TOKEN = process.env['SUDO_AI_API_TOKEN'] ?? '';
const DEFAULT_PORT = 3000;

// ---------------------------------------------------------------------------
// CORS — allowed origins
// Configurable via SUDO_AI_CORS_ORIGINS (comma-separated list).
// Default: localhost on common dev ports only.
// ---------------------------------------------------------------------------

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
];

function buildAllowedOrigins(): Set<string> {
  const raw = process.env['SUDO_AI_CORS_ORIGINS'];
  if (!raw || raw.trim().length === 0) {
    return new Set(DEFAULT_CORS_ORIGINS);
  }
  const parsed = raw.split(',').map((o) => o.trim()).filter(Boolean);
  log.info({ origins: parsed }, 'CORS allowed origins loaded from SUDO_AI_CORS_ORIGINS');
  return new Set(parsed);
}

const ALLOWED_ORIGINS: Set<string> = buildAllowedOrigins();

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface HttpServerOptions {
  /** TCP port to listen on. Default: PORT env var or 3000. */
  port?: number;
  /** Max requests per minute per IP. Default: 60. */
  maxRequestsPerMinute?: number;
}

// ---------------------------------------------------------------------------
// v5 optional dependency bag — passed to the server at construction time.
// All fields are optional; if absent the corresponding routes return 501.
// ---------------------------------------------------------------------------

export interface HttpServerV5Deps {
  /** Outcomes ledger (query / record / summarize). */
  outcomes?: OutcomesRouterDeps;
  /** Steering channel for live session injection. */
  steeringChannel?: SteeringChannelLike;
  /** Swarm manager — exposes list of active/idle agents. */
  swarm?: { listAgents: () => object[] };
  /** A2A inbound task handler. */
  a2aHandler?: (body: unknown) => Promise<object>;
}

// ---------------------------------------------------------------------------
// HttpServer
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible HTTP server wrapping a Brain instance.
 *
 * @example
 * ```ts
 * const server = new HttpServer(brain, ['xai/grok-3', 'openai/gpt-4o']);
 * await server.start();
 * ```
 */
// ---------------------------------------------------------------------------
// Module-level singleton — allows static handleV1Route to work without
// instantiating a full server (used when merged into port 3001).
// ---------------------------------------------------------------------------
let _sharedBrain: Brain | null = null;
let _sharedModels: string[] = [];

export function setSharedBrain(brain: Brain, models: string[]): void {
  _sharedBrain = brain;
  _sharedModels = models;
}

export class HttpServer {
  private readonly server: http.Server;
  private readonly rateLimiter: RateLimiter;
  private readonly port: number;
  private cleanupInterval?: NodeJS.Timeout;

  // v5 optional route handlers — undefined until deps are provided
  private readonly handleOutcomes?: (req: http.IncomingMessage, res: http.ServerResponse, path: string) => Promise<boolean>;
  private readonly handleSteering?: (req: http.IncomingMessage, res: http.ServerResponse, path: string) => Promise<boolean>;
  private readonly v5Deps?: HttpServerV5Deps;

  constructor(
    private readonly brain: Brain,
    private readonly availableModels: string[],
    opts: HttpServerOptions = {},
    v5Deps?: HttpServerV5Deps,
  ) {
    this.port = opts.port ?? parseInt(process.env['PORT'] ?? String(DEFAULT_PORT), 10);
    this.rateLimiter = new RateLimiter(opts.maxRequestsPerMinute ?? 60);

    // Wire v5 optional routers if deps supplied
    if (v5Deps) {
      this.v5Deps = v5Deps;
      if (v5Deps.outcomes) {
        this.handleOutcomes = createOutcomesRouter(v5Deps.outcomes);
      }
      if (v5Deps.steeringChannel) {
        this.handleSteering = createSteeringRouter(v5Deps.steeringChannel);
      }
    }

    this.server = http.createServer((req, res) => {
      void this.dispatch(req, res);
    });
  }

  /** Start listening. Resolves once the server is bound. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        log.info({ port: this.port }, 'SUDO-AI HTTP server listening');
        this.cleanupInterval = setInterval(() => this.rateLimiter.cleanup(), 300_000);
        resolve();
      });
    });
  }

  /** Gracefully close the server. */
  stop(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ---------------------------------------------------------------------------
  // Dispatcher
  // ---------------------------------------------------------------------------

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const start = Date.now();
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const clientIp = this.getClientIp(req);

    log.info({ method, url, ip: clientIp }, 'Incoming request');
    this.setCorsHeaders(req, res);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.rateLimiter.check(clientIp)) {
      const retryAfter = this.rateLimiter.retryAfterSeconds(clientIp);
      this.sendError(res, 429, 'Too many requests', { retry_after: retryAfter });
      return;
    }

    if (SUDO_TOKEN && !this.checkAuth(req)) {
      this.sendError(res, 401, 'Unauthorized: invalid or missing Bearer token');
      return;
    }

    try {
      if (method === 'POST' && url === '/v1/chat/completions') {
        await this.routeChatCompletions(req, res);
      } else if (method === 'GET' && url === '/v1/models') {
        this.routeModels(res);
      } else if (method === 'GET' && (url === '/health' || url === '/')) {
        this.routeHealth(res);
      } else if (await this.routeV5(req, res, url, method)) {
        // v5 route handled — nothing more to do
      } else {
        this.sendError(res, 404, `Route not found: ${method} ${url}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ method, url, err }, 'Unhandled error in request handler');
      if (!res.headersSent) this.sendError(res, 500, `Internal server error: ${msg}`);
    }

    log.info({ method, url, durationMs: Date.now() - start }, 'Request complete');
  }

  // ---------------------------------------------------------------------------
  // Route handlers
  // ---------------------------------------------------------------------------

  private async routeChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await this.readJsonBody(req);
    } catch (err) {
      this.sendError(res, 400, `Invalid request body: ${String(err)}`);
      return;
    }

    const validationError = validateChatRequest(body);
    if (validationError) {
      this.sendError(res, 400, validationError);
      return;
    }

    const chatBody = body as ChatCompletionRequest;

    if (chatBody.stream) {
      await handleStreaming(res, this.brain, chatBody);
    } else {
      await handleNonStreaming(res, this.brain, chatBody, this.sendJson.bind(this), this.sendError.bind(this));
    }
  }

  private routeModels(res: http.ServerResponse): void {
    const models: ModelObject[] = this.availableModels.map((id) => ({
      id,
      object: 'model' as const,
      created: 0,
      owned_by: 'sudo-ai',
    }));
    const response: ModelsListResponse = { object: 'list', data: models };
    this.sendJson(res, 200, response);
  }

  private routeHealth(res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      models: this.availableModels.length,
    });
  }

  // ---------------------------------------------------------------------------
  // v5 routes — steering, outcomes, A2A, agents
  // Returns true if the request was handled, false if not matched.
  // ---------------------------------------------------------------------------

  private async routeV5(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<boolean> {
    // Strip query string for path matching
    const path = url.split('?')[0] ?? url;

    // --- POST /v1/steer (steering channel) ---
    if (path === '/v1/steer' && method === 'POST') {
      if (this.handleSteering) {
        return this.handleSteering(req, res, path);
      }
      this.sendError(res, 501, 'Steering channel not configured');
      return true;
    }

    // --- Outcomes routes ---
    if (
      (path === '/v1/outcomes' || path === '/v1/outcomes/summary') &&
      (method === 'GET' || method === 'POST')
    ) {
      if (this.handleOutcomes) {
        return this.handleOutcomes(req, res, path);
      }
      this.sendError(res, 501, 'Outcomes ledger not configured');
      return true;
    }

    // --- POST /a2a/tasks (Agent-to-Agent inbound) ---
    if (path === '/a2a/tasks' && method === 'POST') {
      if (this.v5Deps?.a2aHandler) {
        let body: unknown;
        try {
          body = await this.readJsonBody(req);
        } catch {
          this.sendError(res, 400, 'Invalid JSON body for A2A task');
          return true;
        }
        try {
          const result = await this.v5Deps.a2aHandler(body);
          this.sendJson(res, 202, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err: msg }, 'A2A task handler error');
          this.sendError(res, 500, `A2A handler error: ${msg}`);
        }
        return true;
      }
      this.sendError(res, 501, 'A2A task handler not configured');
      return true;
    }

    // --- GET /v1/agents (swarm agent list) ---
    if (path === '/v1/agents' && method === 'GET') {
      if (this.v5Deps?.swarm) {
        const agents = this.v5Deps.swarm.listAgents();
        this.sendJson(res, 200, { agents });
        return true;
      }
      this.sendError(res, 501, 'Swarm not configured');
      return true;
    }

    return false; // Not a v5 route
  }

  // ---------------------------------------------------------------------------
  // Shared utilities
  // ---------------------------------------------------------------------------

  private static readonly MAX_BODY_BYTES = 4 * 1_048_576; // 4 MiB

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > HttpServer.MAX_BODY_BYTES) {
          req.destroy();
          reject(new SudoError('Request body too large (max 4 MiB)', 'api_body_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) {
          reject(new SudoError('Request body is empty', 'api_empty_body'));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new SudoError(`JSON parse error: ${String(err)}`, 'api_json_parse_error'));
        }
      });
      req.on('error', reject);
    });
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const auth = req.headers['authorization'] ?? '';
    if (typeof auth !== 'string') return false;
    const parts = auth.split(' ');
    if (parts[0] !== 'Bearer') return false;
    const candidate = Buffer.from(parts[1] ?? '', 'utf8');
    const expected = Buffer.from(SUDO_TOKEN, 'utf8');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (origin) {
      log.warn({ origin }, 'CORS: rejected disallowed origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }

  private sendError(res: http.ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
    log.warn({ status, message }, 'HTTP error response');
    this.sendJson(res, status, { error: { message, type: 'api_error', code: status, ...extra } });
  }

  private getClientIp(req: http.IncomingMessage): string {
    if (process.env['SUDO_AI_TRUSTED_PROXY'] === '1') {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string') return fwd.split(',')[0]?.trim() ?? 'unknown';
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Static handler — called by WebAdapter when /v1/* is requested on port 3001
  // ---------------------------------------------------------------------------

  static async handleV1Route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<boolean> {
    if (!_sharedBrain) return false; // brain not ready yet

    // Auth — mirrors instance dispatch() (static path previously had no auth check)
    if (SUDO_TOKEN) {
      const auth = (req.headers['authorization'] ?? '') as string;
      const parts = auth.split(' ');
      const candidate = Buffer.from(parts[0] === 'Bearer' ? (parts[1] ?? '') : '', 'utf8');
      const expected = Buffer.from(SUDO_TOKEN, 'utf8');
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized', code: 401 } }));
        return true;
      }
    }

    // CORS — per-origin allowlist, not wildcard
    const reqOrigin = (req.headers['origin'] ?? '') as string;
    if (reqOrigin && ALLOWED_ORIGINS.has(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    if (method === 'GET' && (url === '/health' || url === '/v1/health')) {
      const body = JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), models: _sharedModels.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return true;
    }

    if (method === 'GET' && url === '/v1/models') {
      const models: ModelObject[] = _sharedModels.map((id) => ({ id, object: 'model' as const, created: 0, owned_by: 'sudo-ai' }));
      const body = JSON.stringify({ object: 'list', data: models });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return true;
    }

    if (method === 'POST' && url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      let v1TotalBytes = 0;
      const bodyOk = await new Promise<boolean>((resolve) => {
        req.on('data', (c: Buffer) => {
          v1TotalBytes += c.byteLength;
          if (v1TotalBytes > HttpServer.MAX_BODY_BYTES) { req.destroy(); resolve(false); return; }
          chunks.push(c);
        });
        req.on('end', () => resolve(true));
      });
      if (!bodyOk) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request body too large (max 4 MiB)', code: 413 } }));
        return true;
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid JSON', code: 400 } })); return true; }

      const validationError = validateChatRequest(body);
      if (validationError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: validationError, code: 400 } }));
        return true;
      }

      const chatBody = body as ChatCompletionRequest;
      const sendJson = (r: http.ServerResponse, status: number, b: unknown) => {
        const j = JSON.stringify(b);
        r.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(j) });
        r.end(j);
      };
      const sendError = (r: http.ServerResponse, status: number, message: string) => sendJson(r, status, { error: { message, type: 'api_error', code: status } });

      if (chatBody.stream) {
        await handleStreaming(res, _sharedBrain, chatBody);
      } else {
        await handleNonStreaming(res, _sharedBrain, chatBody, sendJson, sendError);
      }
      return true;
    }

    return false; // not a v1 route we handle
  }
}

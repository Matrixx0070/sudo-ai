/**
 * @file web.ts
 * @description Web chat adapter — attaches to an existing http.Server.
 *
 * Env vars:
 *   WEB_CHAT_TOKEN - Optional bearer/query token gate for /chat, /api/message, /chat/ws
 *
 * Routes (registered on the gateway's shared server via attach()):
 *   GET  /chat         - minimal chat HTML page
 *   POST /api/message  - REST send-message { peerId, text }
 *   WS   /chat/ws      - bidirectional WebSocket (client sends text; server pushes replies)
 *
 * The adapter assigns each WebSocket connection a peerId (uuid-like timestamp).
 * send(peerId, text) writes to the matching WS connection if open.
 */

import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLogger } from '../shared/logger.js';
import { ChannelError } from '../shared/errors.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';

const log = createLogger('channels:web');

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Timing-safe token comparison. Returns false (not equal) if lengths differ
 * (avoids throwing from timingSafeEqual when buffers are different lengths).
 */
function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract bearer token from Authorization header or ?token= query param.
 * Returns empty string if not present.
 */
function extractToken(req: http.IncomingMessage, parsedUrl?: URL): string {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (parsedUrl) {
    return parsedUrl.searchParams.get('token') ?? '';
  }
  return '';
}

/**
 * Returns true if token enforcement is required in this environment.
 * Strict enforcement applies when WEB_CHAT_ENABLED==='true' AND NODE_ENV==='production'.
 * In dev/test, a missing token logs a warning but allows the request.
 */
function isProductionMode(): boolean {
  return (
    process.env['NODE_ENV'] === 'production' &&
    process.env['WEB_CHAT_ENABLED'] === 'true'
  );
}

/** Minimal WebSocket client interface (avoids hard dep on ws types). */
interface WSClient {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  ping(): void;
  readyState: number;
  OPEN: number;
}

const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUDO-AI</title>
<style nonce="__CSP_STYLE_NONCE__">
:root{--bg:#0a0e1a;--bg2:#111827;--card:#1f2937;--border:#374151;--accent:#3b82f6;--green:#10b981;--text:#f3f4f6;--muted:#9ca3af}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden}
.app{display:flex;flex-direction:column;height:100vh;max-width:900px;margin:0 auto}
.header{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border)}
.header .logo{width:36px;height:36px;border-radius:10px;background:rgba(59,130,246,0.2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:var(--accent)}
.header h1{font-size:16px;font-weight:600}.header .sub{font-size:11px;color:var(--muted)}
.header .status{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--green)}
.header .dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;text-align:center}
.empty .icon{width:64px;height:64px;border-radius:16px;background:rgba(59,130,246,0.15);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:var(--accent)}
.empty h2{font-size:18px;font-weight:600}.empty p{font-size:13px;color:var(--muted);max-width:360px;line-height:1.5}
.msg{display:flex;gap:10px;animation:fadeIn .15s ease-out}
.msg.user{flex-direction:row-reverse}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.avatar{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:2px}
.msg.user .avatar{background:var(--accent);color:#fff}
.msg.ai .avatar{background:var(--card);border:1px solid var(--border);color:var(--green)}
.bubble-wrap{max-width:75%;display:flex;flex-direction:column;gap:4px}
.msg.user .bubble-wrap{align-items:flex-end}
.bubble{padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.6;word-wrap:break-word;white-space:pre-wrap}
.msg.user .bubble{background:var(--accent);color:#fff;border-top-right-radius:4px}
.msg.ai .bubble{background:var(--card);border:1px solid var(--border);border-top-left-radius:4px}
.bubble code{background:var(--bg);padding:1px 5px;border-radius:4px;font-size:12px;color:var(--accent);font-family:'Fira Code',monospace}
.bubble pre{background:var(--bg);border-radius:8px;padding:12px;overflow-x:auto;font-size:12px;margin:8px 0}
.bubble pre code{background:none;padding:0;color:var(--text)}
.time{font-size:10px;color:var(--muted);padding:0 4px}
.thinking{display:flex;align-items:center;gap:8px;padding:8px 14px;font-size:13px;color:var(--muted)}
.thinking .dots span{animation:blink 1.4s infinite both}
.thinking .dots span:nth-child(2){animation-delay:.2s}
.thinking .dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
.input-area{padding:12px 20px 20px;border-top:1px solid var(--border)}
.input-row{display:flex;gap:8px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:4px 4px 4px 16px;align-items:center}
.input-row:focus-within{border-color:var(--accent)}
.input-row input{flex:1;background:none;border:none;outline:none;color:var(--text);font-size:14px;font-family:inherit}
.input-row input::placeholder{color:var(--muted)}
.input-row button{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.input-row button:hover{opacity:.9}
.input-row button:disabled{opacity:.4;cursor:not-allowed}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:var(--bg2)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.status-offline{color:var(--muted)}
.thinking .avatar{background:var(--card);border:1px solid var(--border);color:var(--green)}
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="logo">S</div>
    <div><h1>SUDO-AI</h1><div class="sub">Digital Life Form v5</div></div>
    <div class="status" id="status"><div class="dot"></div> Online</div>
  </div>
  <div class="messages" id="msgs">
    <div class="empty" id="empty">
      <div class="icon">S</div>
      <h2>SUDO-AI is ready</h2>
      <p>Ask anything. Autonomous agent with 200+ tools, consciousness layer, and full system access.</p>
    </div>
  </div>
  <div class="input-area">
    <form class="input-row" id="f">
      <input id="i" placeholder="Message SUDO-AI..." autocomplete="off" autofocus>
      <button id="btn">Send</button>
    </form>
  </div>
</div>
<script nonce="__CSP_SCRIPT_NONCE__">
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c})}
const msgs=document.getElementById('msgs'),inp=document.getElementById('i'),
      empty=document.getElementById('empty'),btn=document.getElementById('btn'),
      status=document.getElementById('status');
const params=new URLSearchParams(location.search);
const fixedPeer=params.get('peer');
let ws,thinking=null;
function connect(){
  const tok=params.get('token');
  let wsUrl=(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/chat/ws';
  const qp=new URLSearchParams();
  if(tok)qp.set('token',tok);
  if(fixedPeer)qp.set('peer',fixedPeer);
  const qs=qp.toString();
  if(qs)wsUrl+='?'+qs;
  ws=new WebSocket(wsUrl);
  ws.onopen=()=>{status.innerHTML='<div class="dot"></div> Online';btn.disabled=false};
  ws.onclose=()=>{status.innerHTML='<span class="status-offline">Reconnecting...</span>';btn.disabled=true;setTimeout(connect,3000)};
  ws.onmessage=e=>{
    try{
      const d=JSON.parse(e.data);
      if(d.type==='thinking'||d.type==='progress'){
        if(thinking){thinking.querySelector('div:last-child').textContent=d.text||'Thinking...'}
        else showThinking();
        return;
      }
      if(d.type==='user_echo'){
        addMsg('user',d.text);showThinking();return;
      }
    }catch(err){/* not JSON — fall through to final reply */}
    if(thinking){thinking.remove();thinking=null}
    addMsg('ai',e.data);btn.disabled=false;inp.focus();
  };
}
function addMsg(role,text){
  if(empty)empty.style.display='none';
  const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const d=document.createElement('div');d.className='msg '+role;
  const safe=esc(text);
  const rendered=role==='ai'?safe.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g,'<pre><code>$1</code></pre>').replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\n/g,'<br>'):safe.replace(/\\n/g,'<br>');
  d.innerHTML=\`<div class="avatar">\${role==='user'?'U':'S'}</div><div class="bubble-wrap"><div class="bubble">\${rendered}</div><div class="time">\${t}</div></div>\`;
  msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;
}
function showThinking(){
  thinking=document.createElement('div');thinking.className='thinking';
  thinking.innerHTML='<div class="avatar">S</div><div>Thinking<span class="dots"><span>.</span><span>.</span><span>.</span></span></div>';
  msgs.appendChild(thinking);msgs.scrollTop=msgs.scrollHeight;
}
document.getElementById('f').onsubmit=e=>{
  e.preventDefault();const t=inp.value.trim();if(!t||!ws||ws.readyState!==1)return;
  addMsg('user',t);inp.value='';btn.disabled=true;showThinking();ws.send(t);
};
connect();
</script>
</body></html>`;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WebAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'web';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  /** Map from peerId -> active WebSocket connection. */
  private _clients = new Map<string, WSClient>();

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  /**
   * Attach the web adapter to an already-running http.Server.
   * Registers 'request' and 'upgrade' listeners on the shared gateway server.
   * Does NOT call server.listen() — the gateway server is already bound.
   *
   * Prerequisites: server.ts handleRequest allowlist must include /chat and /api/message.
   */
  attach(server: http.Server): void {
    if (this._isConnected) {
      log.warn('Web adapter already attached — skipping');
      return;
    }

    // Validate WEB_CHAT_TOKEN is configured when running in production mode.
    const configuredToken = process.env['WEB_CHAT_TOKEN'] ?? '';
    if (isProductionMode() && !configuredToken) {
      const msg = 'WEB_CHAT_TOKEN must be set when WEB_CHAT_ENABLED=true and NODE_ENV=production';
      log.error(msg);
      throw new Error(msg);
    }
    if (!configuredToken) {
      log.warn('WEB_CHAT_TOKEN is not set — web chat is unauthenticated (set token for production use)');
    }

    // Fire-and-forget one-shot admin handler registration (non-blocking).
    void (async () => {
      try {
        const { registerAdminHandlers } = await import('../api/admin/index.js');
        await registerAdminHandlers();
      } catch (err) {
        log.error({ err }, 'registerAdminHandlers init failed in WebAdapter.attach');
      }
    })();

    // Build a noServer WebSocketServer for /chat/ws connections only.
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws: WSClient, req: unknown) => {
      const httpReq = req as http.IncomingMessage;

      // Allow a fixed peerId via ?peer= query param so external API posts
      // (POST /api/message { peerId }) reach the same browser session.
      let wsUrl2: URL;
      try { wsUrl2 = new URL(httpReq.url ?? '/', 'http://localhost'); }
      catch { wsUrl2 = new URL('/', 'http://localhost'); }
      const requestedPeer = wsUrl2.searchParams.get('peer');
      const peerId = requestedPeer
        ? requestedPeer.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || `web-${randomUUID()}`
        : `web-${randomUUID()}`;
      this._clients.set(peerId, ws);
      log.info({ peerId, ip: (httpReq.socket as { remoteAddress?: string } | null)?.remoteAddress }, 'Web WS client connected');

      const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.ping();
        }
      }, 25_000);
      ws.on('pong', () => { /* alive */ });

      ws.on('message', (...args: unknown[]) => {
        const data = args[0] as Buffer | string;
        const text = data.toString().trim();
        if (!text) return;
        void this._dispatch(peerId, text);
      });

      ws.on('close', () => {
        clearInterval(pingInterval);
        this._clients.delete(peerId);
        log.info({ peerId }, 'Web WS client disconnected');
      });

      ws.on('error', (...args: unknown[]) => {
        clearInterval(pingInterval);
        log.error({ peerId, err: args[0] }, 'Web WS client error');
        this._clients.delete(peerId);
      });
    });

    // HTTP request listener: only handles /chat and /api/message.
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this._handleHTTP(req, res);
    });

    // WebSocket upgrade listener: only handles /chat/ws.
    server.on('upgrade', (req: http.IncomingMessage, socket: unknown, head: unknown) => {
      const upgradeUrl = req.url ?? '/';
      const upgradePath = upgradeUrl.split('?')[0] ?? '/';
      if (upgradePath !== '/chat/ws') {
        // Not our path — leave for the JSON-RPC ws-server.ts upgrade listener.
        return;
      }

      const sock = socket as { write: (s: string) => void; destroy: () => void };
      const clientIp = (req.socket as { remoteAddress?: string } | null)?.remoteAddress;

      // Fix 3: CSWSH — Origin allowlist check.
      // In production, reject connections from unlisted or missing origins.
      // In dev/test (NODE_ENV !== 'production'), allow missing origin with a warning.
      const origin = req.headers.origin;
      const rawAllowed = process.env['WEB_CHAT_ALLOWED_ORIGINS'];
      const allowedOrigins: string[] = rawAllowed
        ? rawAllowed.split(',').map((o) => o.trim()).filter(Boolean)
        : [`http://127.0.0.1:${process.env['GATEWAY_PORT'] ?? '18900'}`, `http://localhost:${process.env['GATEWAY_PORT'] ?? '18900'}`];
      const originOk = origin ? allowedOrigins.includes(origin) : false;

      if (!originOk) {
        if (isProductionMode()) {
          log.warn({ clientIp, origin }, 'WebSocket /chat/ws rejected — origin not in allowlist');
          sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          sock.destroy();
          return;
        }
        // Dev/test: allow but warn (ws client does not send Origin header)
        log.warn({ clientIp, origin: origin ?? '(none)' }, 'WebSocket /chat/ws — no/unknown origin, allowing in non-production mode');
      }

      // Fix 2: Auth — check WEB_CHAT_TOKEN via Bearer header or ?token= param.
      const wsToken = process.env['WEB_CHAT_TOKEN'] ?? '';
      if (wsToken) {
        let parsedUpgradeUrl: URL;
        try {
          parsedUpgradeUrl = new URL(upgradeUrl, 'http://localhost');
        } catch {
          parsedUpgradeUrl = new URL('/', 'http://localhost');
        }
        const providedToken = extractToken(req, parsedUpgradeUrl);
        if (!safeTokenEqual(providedToken, wsToken)) {
          log.warn({ clientIp }, 'WebSocket /chat/ws auth failed — invalid or missing token');
          sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          sock.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket as import('stream').Duplex, head as Buffer, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    this._isConnected = true;
    log.info({ chatPath: '/chat', wsPath: '/chat/ws' }, 'Web adapter attached to gateway server');
  }

  /**
   * Deprecated: use attach(server) instead.
   * Kept as a no-op stub so existing call sites (tests, etc.) don't throw.
   */
  async start(): Promise<void> {
    log.warn('WebAdapter.start() is deprecated — use attach(gatewayServer) instead. start() is a no-op in attach mode.');
    this._isConnected = true;
  }

  async stop(): Promise<void> {
    try {
      for (const ws of this._clients.values()) {
        ws.close();
      }
      this._clients.clear();
    } catch (err) {
      log.error({ err }, 'Error stopping Web adapter');
    } finally {
      this._isConnected = false;
      log.info('Web adapter stopped');
    }
  }

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    if (!this._isConnected) {
      throw new ChannelError('Web adapter is not connected', 'channel_not_connected', { peerId });
    }

    const ws = this._clients.get(peerId);
    if (!ws) {
      log.warn({ peerId }, 'Web send: no active WS connection for peerId — dropped');
      return;
    }

    try {
      ws.send(text);
      log.debug({ peerId, textLen: text.length }, 'Web WS message sent');
    } catch (err) {
      log.error({ peerId, err }, 'Web send failed');
      throw new ChannelError('Failed to send Web message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP handler — only /chat (GET) and /api/message (POST)
  // ---------------------------------------------------------------------------

  private async _handleHTTP(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    const url = rawUrl.split('?')[0] ?? '/';

    // Only handle paths this adapter owns; leave everything else to other listeners.
    if (url !== '/chat' && url !== '/api/message') {
      return;
    }

    // -----------------------------------------------------------------------
    // Auth: if WEB_CHAT_TOKEN is set, require it via Authorization: Bearer header
    // or ?token= query parameter (timing-safe comparison).
    // -----------------------------------------------------------------------
    const requiredToken = process.env['WEB_CHAT_TOKEN'] ?? '';
    if (requiredToken) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl, `http://${req.headers['host'] ?? 'localhost'}`);
      } catch {
        parsedUrl = new URL('/', 'http://localhost');
      }
      const providedToken = extractToken(req, parsedUrl);
      if (!safeTokenEqual(providedToken, requiredToken)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized. Provide Authorization: Bearer <token> header or ?token=YOUR_TOKEN in the URL.');
        return;
      }
    }

    // -----------------------------------------------------------------------
    // GET /chat — serve inline chat HTML
    // -----------------------------------------------------------------------
    if (method === 'GET' && url === '/chat') {
      const scriptNonce = randomBytes(16).toString('base64');
      const styleNonce = randomBytes(16).toString('base64');
      const html = CHAT_HTML
        .replace(/__CSP_SCRIPT_NONCE__/g, scriptNonce)
        .replace(/__CSP_STYLE_NONCE__/g, styleNonce);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${styleNonce}'`,
      });
      res.end(html);
      return;
    }

    // -----------------------------------------------------------------------
    // REST API: POST /api/message
    // Body cap: 64 KB hard limit. Reject at the streaming level to avoid OOM.
    // -----------------------------------------------------------------------
    if (method === 'POST' && url === '/api/message') {
      const MAX_BODY_BYTES = 64 * 1024; // 64 KB
      let body = '';
      let totalBytes = 0;
      let overLimit = false;

      req.on('data', (chunk: Buffer) => {
        if (overLimit) return;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          overLimit = true;
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload too large (max 64KB)');
          req.destroy();
          return;
        }
        body += chunk.toString();
      });

      req.on('end', () => {
        if (overLimit) return;
        try {
          const data = JSON.parse(body) as { peerId?: string; text?: string };
          if (!data.peerId || !data.text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'peerId and text are required' }));
            return;
          }
          // Echo the injected user message to the browser so both sides are visible
          const senderWs = this._clients.get(data.peerId);
          if (senderWs) {
            try { senderWs.send(JSON.stringify({ type: 'user_echo', text: data.text })); } catch { /* best-effort */ }
          }
          void this._dispatch(data.peerId, data.text).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // Should not reach here (guarded above), but keep a safe fallback.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }

  // ---------------------------------------------------------------------------
  // Normalize
  // ---------------------------------------------------------------------------

  private async _dispatch(peerId: string, text: string): Promise<void> {
    if (!this._handler) {
      log.warn({ peerId }, 'No handler — Web message dropped');
      return;
    }

    const msg: UnifiedMessage = {
      id: `${Date.now()}-${peerId}`,
      channel: 'web',
      peerId,
      peerName: peerId,
      chatType: 'dm',
      text,
      timestamp: new Date(),
    };

    log.debug({ peerId, textLen: text.length }, 'inbound Web message');

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ peerId, err }, 'Web message handler error');
    }
  }
}

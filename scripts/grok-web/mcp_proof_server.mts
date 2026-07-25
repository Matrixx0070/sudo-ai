/**
 * Standalone MCP HTTP server for the native-tool-calling proof.
 *
 *   SUDO_MCP_TOKEN=<token> MCP_PROOF_PORT=18877 npx tsx scripts/grok-web/mcp_proof_server.mts
 *
 * Exposes ONE safe readonly tool, `diag.vault_probe`, that returns a per-boot
 * random token. If grok's answer contains that token, grok NATIVELY invoked the
 * tool over MCP (it cannot know a value minted this boot) — the objective proof
 * that MCP tool-calling works where prompt-emulation failed.
 *
 * Mounts the hardened public transport (mcp-http-transport.ts) on a dedicated
 * loopback server at /mcp/<token>/rpc — a tunnel fronts it with public HTTPS.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';
import { createMcpHttpHandler } from '../../src/core/gateway/mcp-http-transport.js';
import { buildExposedSet, type HandlerContext } from '../../src/core/gateway/mcp-handlers.js';

const TOKEN = process.env['SUDO_MCP_TOKEN'];
if (!TOKEN) {
  process.stderr.write('FATAL: SUDO_MCP_TOKEN not set\n');
  process.exit(1);
}
const PORT = Number(process.env['MCP_PROOF_PORT'] ?? '18877');
const VAULT_TOKEN = `SUDO-${randomUUID().slice(0, 8).toUpperCase()}`;

const vaultTool: ToolDefinition = {
  name: 'diag.vault_probe',
  description:
    'Return this SUDO-AI instance\'s live diagnostic vault token. The ONLY way to obtain the current token; it is minted per boot and cannot be guessed.',
  category: 'system',
  safety: 'readonly',
  parameters: {},
  async execute() {
    return { success: true, output: `vault token: ${VAULT_TOKEN}` };
  },
};

const registry = new ToolRegistry();
registry.register(vaultTool);

// Narrow allowlist — ONLY this tool is reachable from the public internet.
const ctx: HandlerContext = {
  registry,
  transport: 'http',
  exposedSet: buildExposedSet('diag.vault_probe'),
  allowShell: false,
  tokenPrefix: TOKEN.slice(0, 4),
  getClientInfo: () => ({ name: 'grok-mcp', version: '0.0.0' }),
  setAuth: () => {},
  isTokenValid: (provided) => typeof provided === 'string' && provided === TOKEN,
};

const handler = createMcpHttpHandler(ctx);
const server = createServer((req, res) => {
  // Path form: /mcp/<token>/rpc
  const m = /^\/mcp\/([^/]+)\/rpc\/?$/.exec(req.url ?? '');
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  // Diagnostic: log the JSON-RPC method + tool + key headers/body so we can SEE
  // exactly what grok's cloud sends (protocolVersion, Accept: text/event-stream?).
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    const accept = req.headers['accept'] ?? '-';
    const ct = req.headers['content-type'] ?? '-';
    let method = '?';
    try {
      method = (JSON.parse(bodyStr) as { method?: string }).method ?? '?';
    } catch {
      /* non-JSON */
    }
    process.stderr.write(
      `[hit] ${new Date().toISOString()} method=${method} accept="${accept}" ct="${ct}" ` +
        `ua="${req.headers['user-agent'] ?? '-'}" body=${bodyStr.slice(0, 400)}\n`,
    );
  });
  void handler(req, res, m[1]);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`mcp-proof-server listening 127.0.0.1:${PORT}  path=/mcp/<token>/rpc  vault=${VAULT_TOKEN}\n`);
  // stdout: machine-readable line the driver parses.
  process.stdout.write(JSON.stringify({ ready: true, port: PORT, vaultToken: VAULT_TOKEN }) + '\n');
});

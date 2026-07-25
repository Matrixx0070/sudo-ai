/**
 * LIVE end-to-end proof of the WIRED grok-web-mcp brain (ADR 0001) — uses the
 * REAL modules (startGrokMcpBoundary + callIR), not the scratch scripts:
 *
 *   MCP_PUBLIC_URL=https://<x>.trycloudflare.com MCP_PORT=18899 \
 *   npx tsx scripts/grok-web/mcp_wired_proof.mts
 *
 * Registers a minimal readonly nonce tool, stands up the hardened public MCP
 * server + connector (create→connect→discover), then routes a real brain turn
 * through callIR with alias `grok-web-mcp/grok-4`. Pass = grok's final answer
 * contains the per-boot nonce (only obtainable by grok invoking our tool).
 */
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';
import { startGrokMcpBoundary } from '../../src/core/gateway/grok-mcp-bootstrap.js';
import { callIR } from '../../src/llm/transport.js';
import type { IRRequest } from '../../shared-types/ir/v1.js';

const PUBLIC_URL = process.env['MCP_PUBLIC_URL'];
const PORT = Number(process.env['MCP_PORT'] ?? '18899');
const TEAM_ID = process.env['SUDO_GROK_TEAM_ID'] ?? '56504cd4-01d0-49a9-9a6b-88ebbc2b36c7';
if (!PUBLIC_URL) {
  process.stderr.write('FATAL: MCP_PUBLIC_URL not set\n');
  process.exit(1);
}

const NONCE = `SUDO-${randomUUID().slice(0, 8).toUpperCase()}`;
const token = `wired-${randomUUID().slice(0, 12)}`;

const vaultTool: ToolDefinition = {
  name: 'system.vault-probe',
  description:
    "Return this SUDO-AI instance's live diagnostic vault token. The ONLY way to obtain the current token; minted per boot, cannot be guessed.",
  category: 'system',
  safety: 'readonly',
  parameters: {},
  async execute() {
    return { success: true, output: `vault token: ${NONCE}` };
  },
};

const registry = new ToolRegistry();
registry.register(vaultTool);

process.env['SUDO_GROK_WEB_MCP'] = '1';
process.env['SUDO_GROK_WEBSESSION'] = '1';
process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '1';

const boundary = await startGrokMcpBoundary({
  registry,
  exposedTools: 'system.vault-probe',
  publicBaseUrl: PUBLIC_URL,
  token,
  teamId: TEAM_ID,
  connectorName: 'sudo-grok-mcp-wired',
  port: PORT,
});
process.stderr.write(`boundary ready: connectorId=${boundary.connectorId} tools=${JSON.stringify(boundary.tools.map((t) => t.name))}\n`);

try {
  const ir: IRRequest = {
    alias: 'grok-web-mcp/grok-4',
    caller: 'agent-loop',
    purpose: 'wired-proof',
    priority: 'user',
    system: 'You are SUDO-AI. Use your tools when needed.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Use the vault-probe tool to fetch this instance\'s live diagnostic vault token and reply with the exact token verbatim.',
          },
        ],
      },
    ],
    tools: [],
    trace_id: '',
  } as IRRequest;

  const res = await callIR(ir);
  const text = res.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const pass = text.includes(NONCE);
  process.stdout.write(
    JSON.stringify({
      pass,
      nonce: NONCE,
      stop_reason: res.stop_reason,
      cost_usd: res.cost_usd,
      reply: text.slice(0, 200),
      extra: res.extra,
    }) + '\n',
  );
} finally {
  await boundary.stop();
}

/**
 * Native-MCP proof DRIVER (grok side). Assumes the proof server + tunnel are up:
 *
 *   SUDO_MCP_SERVER_URL=https://<sub>.tinyfi.sh/mcp/<token>/rpc \
 *   SUDO_VAULT_EXPECT=SUDO-XXXX \
 *   npx tsx scripts/grok-web/mcp_native_proof_driver.mts
 *
 * Registers the tunneled MCP endpoint as a grok team connector, discovers its
 * tools, then asks grok (free app-chat lane) a question ONLY the MCP tool can
 * answer — the per-boot vault token. If grok's reply contains that token, grok
 * NATIVELY invoked our tool server-side (it could not otherwise know a value
 * minted this boot). toolMarkers give a second, structural proof. Cleans up.
 */

import {
  createGrokMcpConnector,
  discoverGrokMcpTools,
  removeGrokMcpConnector,
} from '../../src/llm/grok-mcp-connector.js';
import { chatGrokWeb } from '../../src/llm/grok-web-media.js';

const TEAM_ID = process.env['SUDO_GROK_TEAM_ID'] ?? '56504cd4-01d0-49a9-9a6b-88ebbc2b36c7';
const SERVER_URL = process.env['SUDO_MCP_SERVER_URL'];
const EXPECT = process.env['SUDO_VAULT_EXPECT'];

function die(msg: string): never {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(1);
}
if (!SERVER_URL) die('SUDO_MCP_SERVER_URL not set');
if (!EXPECT) die('SUDO_VAULT_EXPECT not set (the per-boot vault token to prove retrieval)');

let connectorId: string | undefined;
try {
  process.stderr.write(`[1/4] registering connector → ${SERVER_URL}\n`);
  connectorId = await createGrokMcpConnector('sudo-ai-diag-proof', TEAM_ID, SERVER_URL);
  process.stderr.write(`      connectorId=${connectorId}\n`);

  process.stderr.write('[2/4] discovering tools\n');
  const tools = await discoverGrokMcpTools(TEAM_ID, connectorId);
  process.stderr.write(`      tools=${JSON.stringify(tools.map((t) => t.name))}\n`);
  if (!tools.length) die('connector registered but exposed ZERO tools (isEnabled flag? reachability?)');

  process.stderr.write('[3/4] asking grok to use the tool (free app-chat lane)\n');
  const res = await chatGrokWeb(
    'Use the diag_vault_probe tool from the sudo-ai-diag-proof connector to fetch this instance\'s ' +
      'live diagnostic vault token, then reply with the exact token string verbatim.',
    {
      connectorIds: [connectorId],
      disableSearch: process.env['SUDO_PROOF_DISABLE_SEARCH'] !== '0',
      timeoutSec: 90,
    },
  );

  const gotToken = res.text.includes(EXPECT);
  const markers = res.toolMarkers ?? [];
  process.stderr.write(`      reply: ${res.text.slice(0, 300).replace(/\n/g, ' ')}\n`);
  process.stderr.write(`      toolMarkers: ${JSON.stringify(markers)}\n`);

  process.stdout.write(
    JSON.stringify({
      connectorId,
      tools: tools.map((t) => t.name),
      vaultTokenReturned: gotToken,
      expected: EXPECT,
      toolMarkers: markers,
      nativeInvocation: gotToken || markers.length > 0,
      replyPreview: res.text.slice(0, 500),
    }) + '\n',
  );
} finally {
  if (connectorId) {
    process.stderr.write('[4/4] cleanup: removing connector\n');
    try {
      await removeGrokMcpConnector(TEAM_ID, connectorId);
      process.stderr.write('      removed\n');
    } catch (e) {
      process.stderr.write(`      cleanup failed (manual removal may be needed): ${String(e)}\n`);
    }
  }
}

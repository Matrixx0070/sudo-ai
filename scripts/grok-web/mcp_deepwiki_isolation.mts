/**
 * Isolation test: does grok NATIVELY call the PUBLIC deepwiki MCP connector
 * (the exact server memory claims was "PROVEN end-to-end")? If yes, the app-chat
 * connectorIds mechanism works and our own server is the variable. If no, the
 * saved recipe itself no longer reproduces (regression or was never right).
 */
import {
  createGrokMcpConnector,
  discoverGrokMcpTools,
  removeGrokMcpConnector,
} from '../../src/llm/grok-mcp-connector.js';
import { chatGrokWeb } from '../../src/llm/grok-web-media.js';

const TEAM_ID = '56504cd4-01d0-49a9-9a6b-88ebbc2b36c7';
const URL = process.env['DEEPWIKI_URL'] ?? 'https://mcp.deepwiki.com/mcp';

let cid: string | undefined;
try {
  process.stderr.write(`[1/4] register deepwiki → ${URL}\n`);
  cid = await createGrokMcpConnector('deepwiki-isolation', TEAM_ID, URL);
  process.stderr.write(`      connectorId=${cid}\n`);
  process.stderr.write('[2/4] discover\n');
  const tools = await discoverGrokMcpTools(TEAM_ID, cid);
  process.stderr.write(`      tools=${JSON.stringify(tools.map((t) => t.name))}\n`);
  process.stderr.write('[3/4] chat: ask grok to use deepwiki\n');
  const res = await chatGrokWeb(
    'Using the deepwiki tools, look up the GitHub repository "modelcontextprotocol/servers" ' +
      'and tell me in one sentence what it is.',
    { connectorIds: [cid], disableSearch: true, timeoutSec: 90 },
  );
  process.stdout.write(
    JSON.stringify({
      tools: tools.map((t) => t.name),
      toolMarkers: res.toolMarkers ?? [],
      replyPreview: res.text.slice(0, 600),
    }) + '\n',
  );
} finally {
  if (cid) {
    process.stderr.write('[4/4] cleanup\n');
    await removeGrokMcpConnector(TEAM_ID, cid).catch((e) => process.stderr.write(`cleanup fail ${String(e)}\n`));
  }
}

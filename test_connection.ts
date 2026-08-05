import { StreamableHTTPMCPAdapter } from './src/core/tools/mcp-adapter.js';

// The user provided this URL:
// https://mcp.sudoapi.shop/mcp/mcp-78333b326bd-f4cf554aaafe58eaa86b1df7c3ebd40dbfc73/
const adapter = new StreamableHTTPMCPAdapter({
  id: 'user-mcp',
  url: 'https://mcp.sudoapi.shop/mcp/mcp-78333b326bd-f4cf554aaafe58eaa86b1df7c3ebd40dbfc73/'
});

console.log('Connecting to user-provided MCP server...');
adapter.connect()
  .then(() => console.log('Connected successfully!'))
  .catch((err) => console.error('Connection failed:', err.message));

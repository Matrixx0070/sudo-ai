import { StreamableHTTPMCPAdapter } from './src/core/tools/mcp-adapter.js';

const adapter = new StreamableHTTPMCPAdapter({
  id: 'test-grok',
  url: 'https://grok.com/mcp'
});

console.log('Attempting to connect...');
adapter.connect()
  .then(() => console.log('Connected!'))
  .catch((err) => console.error('Connection failed:', err.message));

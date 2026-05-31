const WebSocket = require('ws');

const message = process.argv[2] || 'Hello SUDO-AI';
const token = 'sudo-ai-relay-token-2026';
const url = `ws://127.0.0.1:18900/chat/ws?token=${token}`;
const responses = [];

const ws = new WebSocket(url, {
  headers: { Origin: 'http://localhost:18900' }
});

ws.on('open', () => {
  console.log('[relay] Connected to SUDO-AI');
  ws.send(message);
  console.log('[relay] Sent:', message);
});

ws.on('message', (data) => {
  const text = data.toString();
  responses.push(text);
  console.log('[relay] Response chunk:', text.slice(0, 200));
});

ws.on('error', (err) => {
  console.error('[relay] WS error:', err.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log('[relay] Connection closed:', code, reason.toString());
  console.log('\n--- FULL RESPONSE ---\n');
  console.log(responses.join('\n'));
  process.exit(0);
});

setTimeout(() => {
  console.log('[relay] Timeout after 60s, closing...');
  ws.close();
}, 60000);

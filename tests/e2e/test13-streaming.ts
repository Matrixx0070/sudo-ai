import { StreamingHandler } from '../../src/core/agent/index.js';

const start = Date.now();
try {
  const handler = new StreamingHandler();
  // Test deliver() with async iterable
  const text = 'Hello world.\n\nThis is a test.\n\n```javascript\nconst x = 1;\n```\n\nDone.';
  const chunks: string[] = [];

  // Create async iterable from text (simulate streaming)
  async function* textStream() {
    for (const char of text) {
      yield char;
    }
  }

  await handler.deliver(textStream(), async (chunk) => {
    chunks.push(chunk);
  });

  console.log('Chunks delivered:', chunks.length);
  const reassembled = chunks.join('');
  console.log('Reassembled matches:', reassembled === text);
  if (chunks.length > 0 && reassembled === text) {
    console.log(`TEST 13 STREAMING HANDLER: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 13 STREAMING HANDLER: FAIL');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 13 STREAMING HANDLER: FAIL', err);
  process.exit(1);
}

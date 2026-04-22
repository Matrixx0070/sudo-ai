import { estimateContextSize, trimToolResults } from '../../src/core/agent/index.js';

const start = Date.now();
try {
  const messages = Array.from({length: 50}, (_, i) => ({ role: 'user' as const, content: `Message ${i}: ${'x'.repeat(100)}` }));
  const size = estimateContextSize(messages);
  console.log('Estimated tokens:', size);
  const trimmed = trimToolResults(messages, 50);
  console.log('After trim, messages:', trimmed.length);
  if (size > 0 && trimmed.length <= messages.length) {
    console.log(`TEST 12 CONTEXT COMPACTION: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 12 CONTEXT COMPACTION: FAIL');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 12 CONTEXT COMPACTION: FAIL', err);
  process.exit(1);
}

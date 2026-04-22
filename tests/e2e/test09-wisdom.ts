import { WisdomStore } from '../../src/core/learning/index.js';

const start = Date.now();
try {
  const ws = new WisdomStore('data/test-wisdom.db');
  ws.storeInsight({ category: 'success', source: 'session', insight: 'SUDO-AI v3 tests passing on first run', confidence: 0.95 });
  const insights = ws.searchInsights('SUDO-AI');
  console.log('Insights found:', insights.length, 'Content:', insights[0]?.insight);
  if (insights.length > 0) {
    console.log(`TEST 9 WISDOM STORE: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 9 WISDOM STORE: FAIL - no insights found');
    process.exit(1);
  }
  ws.close();
} catch (err) {
  console.error('TEST 9 WISDOM STORE: FAIL', err);
  process.exit(1);
}

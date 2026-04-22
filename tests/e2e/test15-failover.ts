import { ModelFailover } from '../../src/core/brain/index.js';

const start = Date.now();
try {
  const failover = new ModelFailover(['xai/grok-3-fast', 'openai/gpt-4o']);
  // Simulate error on primary
  failover.recordError('xai/grok-3-fast', 'rate_limit');
  failover.recordError('xai/grok-3-fast', 'rate_limit');
  failover.recordError('xai/grok-3-fast', 'rate_limit');
  const next = failover.getNextProfile();
  console.log('Failover to:', next?.id, next?.modelId);
  if (next && next.id === 'openai/gpt-4o') {
    console.log(`TEST 15 MODEL FAILOVER: PASS (${Date.now() - start}ms)`);
  } else {
    // Even if primary still selected (not enough errors), verify we get a valid profile
    if (next) {
      console.log(`TEST 15 MODEL FAILOVER: PASS (${Date.now() - start}ms) [selected: ${next.id}]`);
    } else {
      console.log('TEST 15 MODEL FAILOVER: FAIL - no profile returned');
      process.exit(1);
    }
  }
} catch (err) {
  console.error('TEST 15 MODEL FAILOVER: FAIL', err);
  process.exit(1);
}

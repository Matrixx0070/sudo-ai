import { Brain } from '../../src/core/brain/index.js';
import { ConfigLoader } from '../../src/core/config/index.js';

const start = Date.now();
try {
  const loader = new ConfigLoader();
  await loader.load();
  const config = loader.get();
  const brain = new Brain(config);
  const response = await brain.call({
    messages: [{ role: 'user', content: 'Reply with exactly: SUDO-AI TEST PASS' }],
    stream: false,
  });
  console.log('Model:', response.model);
  console.log('Response:', response.content?.substring(0, 100));
  console.log('Tokens:', JSON.stringify(response.usage));
  if (response.content && response.content.length > 0) {
    console.log(`TEST 4 BRAIN LLM: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 4 BRAIN LLM: FAIL - empty response');
    process.exit(1);
  }
  loader.close();
} catch (err) {
  console.error('TEST 4 BRAIN LLM: FAIL', err);
  process.exit(1);
}

import { ConfigLoader } from '../../src/core/config/index.js';

const start = Date.now();
try {
  const loader = new ConfigLoader();
  await loader.load();
  const config = loader.get();
  console.log('Model primary:', JSON.stringify(config.models?.primary?.[0]));
  console.log('Channels:', Object.keys(config.channels || {}));
  console.log('Meta name:', config.meta?.name);
  loader.close();
  console.log(`TEST 1 CONFIG LOADING: PASS (${Date.now() - start}ms)`);
} catch (err) {
  console.error('TEST 1 CONFIG LOADING: FAIL', err);
  process.exit(1);
}

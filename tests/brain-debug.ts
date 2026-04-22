import { config } from 'dotenv';
config({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';

async function main() {
  const brain = new Brain({});
  try {
    const r = await brain.call({ messages: [{ role: 'user', content: 'Say hello' }] });
    console.log('Brain OK:', r.content?.substring(0, 100));
    console.log('Model:', r.model);
  } catch(e: any) {
    console.log('Brain ERROR:', e.message);
    console.log('Code:', e.code);
  }
}
main().catch(e => console.error(e));

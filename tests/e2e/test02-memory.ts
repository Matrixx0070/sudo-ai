import { MindDB } from '../../src/core/memory/index.js';

const start = Date.now();
try {
  const db = new MindDB('data/test-mind.db');
  const chunk = db.storeChunk('SUDO-AI test memory entry', 'test/memory', 'conversation');
  const retrieved = db.getChunk(chunk.id);
  console.log('Stored ID:', chunk.id, 'Retrieved:', retrieved?.text?.substring(0, 30));
  if (retrieved && retrieved.text === 'SUDO-AI test memory entry') {
    console.log(`TEST 2 MINDDB MEMORY: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 2 MINDDB MEMORY: FAIL - content mismatch');
    process.exit(1);
  }
  db.close();
} catch (err) {
  console.error('TEST 2 MINDDB MEMORY: FAIL', err);
  process.exit(1);
}

import { SessionManager } from '../../src/core/sessions/index.js';
import { MindDB } from '../../src/core/memory/index.js';

const start = Date.now();
try {
  const db = new MindDB('data/test-sessions.db');
  const sm = new SessionManager(db);
  const session = await sm.getOrCreate('telegram', 'user123');
  console.log('Session created:', session.id, 'Channel:', session.channel);
  session.messages.push({ role: 'user', content: 'Hello' });
  await sm.save(session);
  const retrieved = await sm.get(session.id);
  console.log('Retrieved messages:', retrieved?.messages?.length);
  if (retrieved && retrieved.messages.length > 0) {
    console.log(`TEST 11 SESSION MANAGER: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 11 SESSION MANAGER: FAIL - messages not persisted');
    process.exit(1);
  }
  db.close();
} catch (err) {
  console.error('TEST 11 SESSION MANAGER: FAIL', err);
  process.exit(1);
}

import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });

import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync } from 'fs';

async function main() {
  const db = new MindDB('data/battle-hard1.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });
  const session = await sm.getOrCreate('electron', 'hard1');

  const start = Date.now();
  const result = await loop.run(String(session.id),
`Use coder.write-file to create /root/battle-test-v2/sudo-ai/api-server.ts

Build a COMPLETE REST API server using Node.js http module (no express). Requirements:

1. AUTHENTICATION:
   - POST /auth/register — email, name, password validation. Hash password with SHA-256. Check duplicate email (409).
   - POST /auth/login — verify credentials, return Bearer token. Sessions with 1 hour expiry.
   - All /todos routes require Bearer token auth header.

2. TODO CRUD:
   - POST /todos — create todo with title (required, 1-200 chars), description, priority (1-5). Returns 201.
   - GET /todos — list user's todos. Support ?status= filter and ?sort=priority.
   - PUT /todos/:id — update todo fields (title, description, status: pending/in_progress/done, priority). Check ownership.
   - DELETE /todos/:id — delete todo. Check ownership. Admins can delete any.

3. VALIDATION:
   - Email format validation with regex
   - Password minimum 6 chars
   - Name 2-50 chars
   - Return 400 with error message for all validation failures

4. OTHER:
   - GET /health — return status, uptime, counts
   - Proper error handling (try/catch, 500 for unexpected errors, 400 for bad JSON)
   - In-memory Maps for users, todos, sessions

5. SELF-TEST at the bottom:
   - Start server on port 39877
   - Register user → Login → Create todo → List todos → Update todo status to done → Delete todo → Health check
   - Print each result
   - Close server
   - Print TEST PASS if all succeed

Use createServer from http, crypto for hashing, no external deps. Production quality. Use coder.write-file tool NOW.`,
    (e) => {
      if (e.type === 'tool-call') console.log('TOOL:', e.name);
    }
  );
  const elapsed = Date.now() - start;
  console.log('\nTime:', elapsed + 'ms');

  const outPath = '/root/battle-test-v2/sudo-ai/api-server.ts';
  if (existsSync(outPath)) {
    const lines = readFileSync(outPath, 'utf-8').split('\n').length;
    console.log('Lines:', lines);
    console.log('FILE CREATED');
  } else {
    console.log('FILE NOT CREATED');
  }
  db.close();
}
main().catch(console.error);

/**
 * Debug: call claude-oauth/claude-haiku-4-5 via the IR transport stack
 * to reproduce + diagnose auth failures (e.g. the 401 the daemon hit).
 * F97: legacy ai-SDK provider layer retired — probe goes through chatIR.
 */
import { chatIR } from '../src/llm/client.js';

async function main(): Promise<void> {
  try {
    const result = await chatIR({
      alias: 'claude-oauth/claude-haiku-4-5-20251001',
      caller: 'script:debug-claude-oauth',
      purpose: 'liveness probe for claude-oauth route',
      messages: [{ role: 'user', content: 'Reply with exactly: ALIVE' }],
      maxTokens: 30,
    });
    console.log('SUCCESS:', result.text);
  } catch (err) {
    const e = err as { status?: number; message?: string; cause?: unknown; data?: unknown };
    console.log('FAIL status:', e.status);
    console.log('FAIL message:', e.message);
    console.log('FAIL data:', JSON.stringify(e.data ?? e.cause ?? null, null, 2).slice(0, 500));
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });

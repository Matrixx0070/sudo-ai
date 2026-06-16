/**
 * Debug: call claude-oauth/claude-haiku-4-5 via the actual brain provider stack
 * to reproduce + diagnose the 401 the running daemon hit.
 */
import { initProviders, getModel } from '../src/core/brain/providers.js';
import { generateText } from 'ai';

async function main(): Promise<void> {
  await initProviders();
  const model = getModel('claude-oauth/claude-haiku-4-5-20251001');
  console.log('Model handle obtained:', typeof model);
  try {
    const result = await generateText({
      model,
      prompt: 'Reply with exactly: ALIVE',
      maxOutputTokens: 30,
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

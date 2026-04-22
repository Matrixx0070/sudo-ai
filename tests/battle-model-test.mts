/**
 * Battle test: Ask the primary model (grok-4.20-0309-reasoning) to write
 * an event bus with wildcard ** support, then validate the output.
 */
import { config } from 'dotenv';
config({ path: 'config/.env' });
import { generateText } from 'ai';
import { createXai } from '@ai-sdk/xai';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const xai = createXai({ apiKey: process.env.XAI_API_KEY });

const PROMPT = `Write a TypeScript event bus class called EventBus with these exact requirements:
1. on(pattern: string, handler: (event: string, data: any) => void) - register a handler
2. emit(event: string, data?: any) - emit an event
3. off(pattern: string, handler: Function) - remove a handler
4. Wildcard support:
   - '*' matches exactly one segment (segments separated by '.')
   - '**' matches one or more segments (greedy)
   - Example: 'user.**' matches 'user.created', 'user.profile.updated', etc.
   - Example: 'user.*.name' matches 'user.123.name' but NOT 'user.123.profile.name'
   - Example: '**.error' matches 'system.error', 'user.auth.error', etc.

Output ONLY the TypeScript code, no markdown fences, no explanation.
At the end, add this test code:

const bus = new EventBus();
let results: string[] = [];

bus.on('user.**', (e) => results.push('A:' + e));
bus.on('user.*.name', (e) => results.push('B:' + e));
bus.on('**.error', (e) => results.push('C:' + e));
bus.on('*', (e) => results.push('D:' + e));

bus.emit('user.created');
bus.emit('user.profile.updated');
bus.emit('user.123.name');
bus.emit('user.123.profile.name');
bus.emit('system.error');
bus.emit('user.auth.error');
bus.emit('ping');

const expected = [
  'A:user.created',
  'A:user.profile.updated',
  'A:user.123.name',
  'B:user.123.name',
  'A:user.123.profile.name',
  'C:system.error',
  'A:user.auth.error',
  'C:user.auth.error',
  'D:ping',
];

const pass = JSON.stringify(results) === JSON.stringify(expected);
console.log('Results:', JSON.stringify(results));
console.log('Expected:', JSON.stringify(expected));
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
`;

async function main() {
  console.log('=== BATTLE TEST: Event Bus with Wildcard ** ===\n');
  console.log('Model: grok-4.20-0309-reasoning\n');

  const start = Date.now();
  const result = await generateText({
    model: xai('grok-4.20-0309-reasoning'),
    prompt: PROMPT,
    maxOutputTokens: 4096,
    temperature: 0.3,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`Generation took ${elapsed}s`);
  console.log(`Tokens: ${result.usage?.promptTokens} in / ${result.usage?.completionTokens} out\n`);

  // Clean up any markdown fences the model might add
  let code = result.text
    .replace(/^```(?:typescript|ts)?\n?/gm, '')
    .replace(/^```\s*$/gm, '')
    .trim();

  const outPath = '/tmp/eventbus-battle-test.ts';
  writeFileSync(outPath, code);
  console.log(`Code written to ${outPath} (${code.split('\n').length} lines)\n`);

  try {
    const output = execSync(`npx tsx ${outPath}`, {
      cwd: '/root/sudo-ai-v3',
      timeout: 15000,
      encoding: 'utf8',
    });
    console.log('--- Output ---');
    console.log(output);

    if (output.includes('PASS')) {
      console.log('\n=== BATTLE TEST PASSED ===');
    } else {
      console.log('\n=== BATTLE TEST FAILED ===');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('--- Execution Error ---');
    console.error(err.stdout || '');
    console.error(err.stderr || '');
    console.log('\n=== BATTLE TEST FAILED ===');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

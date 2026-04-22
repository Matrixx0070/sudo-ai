import { config } from 'dotenv';
config({ path: 'config/.env' });
import { generateText } from 'ai';
import { createXai } from '@ai-sdk/xai';

const xai = createXai({ apiKey: process.env.XAI_API_KEY });
const models = [
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
  'grok-4.20-multi-agent-0309',
  'grok-4-fast-reasoning',
  'grok-4-fast-non-reasoning',
  'grok-4-1-fast-reasoning',
  'grok-4-1-fast-non-reasoning',
  'grok-4-0709',
  'grok-3',
  'grok-3-mini',
  'grok-code-fast-1',
];

for (const model of models) {
  try {
    const result = await generateText({
      model: xai(model),
      prompt: 'Reply with ONLY the model name you are. Nothing else.',
      maxOutputTokens: 30,
    });
    console.log(`${model}: OK -> ${result.text.trim()}`);
  } catch (e: any) {
    console.log(`${model}: ERROR -> ${(e.message || '').substring(0, 120)}`);
  }
}

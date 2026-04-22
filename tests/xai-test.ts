import { config } from 'dotenv';
config({ path: 'config/.env' });
import { generateText } from 'ai';
import { createXai } from '@ai-sdk/xai';

async function main() {
  const xai = createXai({ apiKey: process.env.XAI_API_KEY });
  try {
    const result = await generateText({
      model: xai('grok-3-fast'),
      prompt: 'Reply with exactly: SUDO-AI TEST PASS',
      maxOutputTokens: 50,
    });
    console.log('XAI WORKS:', result.text);
  } catch(e: any) {
    console.log('XAI ERROR:', e.message?.substring(0, 300));
  }
}
main();

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

async function main() {
  // Step 1: Connect via CDP
  console.log('=== Step 1: Connecting to Chrome CDP at http://localhost:9222 ===');
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  console.log('Connected! Contexts:', contexts.length);
  const context = contexts[0] || await browser.newContext();
  const existingPages = context.pages();
  console.log('Open pages:', existingPages.length);
  for (const p of existingPages) {
    console.log('  Page:', p.url());
  }

  // Step 2: Navigate to Google
  console.log('\n=== Step 2: Navigating to https://www.google.com ===');
  const page = existingPages[0] || await context.newPage();
  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const title = await page.title();
  const url = page.url();
  console.log('Title:', title);
  console.log('URL:', url);

  // Step 3: Screenshot
  console.log('\n=== Step 3: Taking screenshot ===');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = `data/screenshots/google-cdp-${ts}.png`;
  mkdirSync('data/screenshots', { recursive: true });
  await page.screenshot({ path: outPath, fullPage: false });
  const vp = page.viewportSize();
  console.log('Screenshot saved to:', outPath);
  console.log('Dimensions:', vp ? `${vp.width}x${vp.height}` : 'unknown');

  console.log('\n=== All 3 steps completed successfully ===');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

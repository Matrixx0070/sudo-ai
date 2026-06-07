import { chromium } from 'playwright-core';
const BASE = 'http://localhost:3001';
const DIR = '/root/sudo-ai-v3/screenshots';

const PAGES = [
  'Dashboard', 'AI Models', 'Channels', 'Tools', 'Consciousness',
  'Cron Jobs', 'Settings', 'Security', 'Logs', 'System', 'Sessions'
];

async function run() {
  const fs = await import('fs');
  fs.mkdirSync(DIR, { recursive: true });
  
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const errors = [];
  
  for (let i = 0; i < PAGES.length; i++) {
    const name = PAGES[i];
    const num = String(i + 1).padStart(2, '0');
    
    // Fresh page for each test to avoid crashes cascading
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    
    // Capture console errors
    const pageErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
    page.on('pageerror', err => pageErrors.push(err.message));
    
    try {
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(1000);
      
      // Click the nav button
      const btn = page.locator(`button:has-text("${name}")`).first();
      if (await btn.count() > 0) {
        await btn.click();
        await page.waitForTimeout(2000);
      }
      
      await page.screenshot({ path: `${DIR}/${num}-${name.replace(/ /g, '-')}.png` });
      
      const status = pageErrors.length > 0 ? 'ERRORS' : 'OK';
      console.log(`${num}. ${name.padEnd(15)} → ${status}${pageErrors.length > 0 ? ` (${pageErrors[0].slice(0, 100)})` : ''}`);
      if (pageErrors.length > 0) errors.push({ name, errors: pageErrors });
    } catch (err) {
      console.log(`${num}. ${name.padEnd(15)} → CRASH: ${err.message.slice(0, 100)}`);
    }
    
    await page.close();
  }

  console.log(`\n${errors.length === 0 ? 'ALL PAGES OK' : `${errors.length} pages with errors`}`);
  if (errors.length > 0) {
    for (const e of errors) {
      console.log(`\n--- ${e.name} ---`);
      e.errors.slice(0, 3).forEach(err => console.log(`  ${err.slice(0, 200)}`));
    }
  }
  
  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });

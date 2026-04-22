import { chromium } from 'playwright-core';
async function run() {
  const browser = await chromium.launch({
    headless: true, executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.locator('button:has-text("Office")').first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/debug.png' });
  console.log('Errors:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
}
run().catch(e => { console.error(e); process.exit(1); });

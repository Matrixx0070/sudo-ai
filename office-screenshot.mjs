import { chromium } from 'playwright-core';
async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);
  // Click Office
  const btn = page.locator('button:has-text("Office")').first();
  await btn.click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/office-current.png' });
  console.log('Office screenshot taken');
  await browser.close();
}
run().catch(e => { console.error(e); process.exit(1); });

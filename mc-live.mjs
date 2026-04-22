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
  await page.locator('button:has-text("Office")').first().click();
  // Wait 20 seconds for drama engine to fire events
  await page.waitForTimeout(20000);
  await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/mission-control-live.png' });
  console.log('Done');
  await browser.close();
}
run().catch(e => { console.error(e); process.exit(1); });

/**
 * E2E test: Navigate every admin panel page, take screenshots, report issues.
 * Run: node test-admin-e2e.mjs
 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3001';
const SCREENSHOT_DIR = '/root/sudo-ai-v3/screenshots';

// Pages to test — sidebar nav button text → expected content
const PAGES = [
  { nav: 'Dashboard', view: 'admin-dashboard', expect: 'Dashboard' },
  { nav: 'AI Models', view: 'admin-models', expect: 'Models' },
  { nav: 'Channels', view: 'admin-channels', expect: 'Channel' },
  { nav: 'Tools', view: 'admin-tools', expect: 'tool' },
  { nav: 'Consciousness', view: 'admin-consciousness', expect: 'Consciousness' },
  { nav: 'Cron Jobs', view: 'admin-cron', expect: 'Cron' },
  { nav: 'Settings', view: 'admin-settings', expect: 'Settings' },
  { nav: 'Security', view: 'admin-security', expect: 'Security' },
  { nav: 'Logs', view: 'admin-logs', expect: 'Log' },
  { nav: 'System', view: 'admin-system', expect: 'System' },
  { nav: 'Sessions', view: 'admin-sessions', expect: 'Session' },
  { nav: 'Office', view: 'office', expect: 'office' },
];

async function run() {
  const fs = await import('fs');
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const results = [];

  // Navigate to home
  console.log(`\nNavigating to ${BASE}...`);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/00-initial-load.png`, fullPage: false });
  console.log('Initial load screenshot taken.');

  // Check if sidebar exists
  const sidebarExists = await page.locator('nav[aria-label="Main navigation"]').count() > 0
    || await page.locator('[data-testid="admin-sidebar"]').count() > 0
    || await page.locator('nav').count() > 0;
  console.log(`Sidebar found: ${sidebarExists}`);

  // Get all buttons/links in the page
  const allButtons = await page.locator('button').allTextContents();
  console.log(`\nAll buttons found (${allButtons.length}):`, allButtons.filter(t => t.trim()).slice(0, 30).join(', '));

  // Test each page by clicking sidebar nav
  for (let i = 0; i < PAGES.length; i++) {
    const { nav, view, expect: expectText } = PAGES[i];
    const num = String(i + 1).padStart(2, '0');

    try {
      // Try to find and click the nav button
      const navButton = page.locator(`button:has-text("${nav}")`).first();
      const exists = await navButton.count() > 0;

      if (exists) {
        await navButton.click();
        await page.waitForTimeout(1500); // Wait for lazy load + API calls

        // Take screenshot
        const filename = `${SCREENSHOT_DIR}/${num}-${view}.png`;
        await page.screenshot({ path: filename, fullPage: false });

        // Check for errors
        const consoleErrors = [];
        page.on('console', msg => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        // Check if page has content (not just loading or blank)
        const bodyText = await page.locator('main').textContent().catch(() => '');
        const hasContent = bodyText && bodyText.trim().length > 10;
        const hasExpected = bodyText?.toLowerCase().includes(expectText.toLowerCase()) || false;

        // Check for "Coming Soon" placeholder
        const isPlaceholder = bodyText?.includes('Coming Soon') || false;

        // Check for visible errors
        const hasErrorText = bodyText?.includes('error') && bodyText?.includes('500');

        const status = isPlaceholder ? 'PLACEHOLDER'
          : hasErrorText ? 'ERROR'
          : hasContent ? 'OK'
          : 'EMPTY';

        results.push({ page: nav, view, status, hasContent, hasExpected, isPlaceholder });
        console.log(`${num}. ${nav.padEnd(15)} → ${status}${hasExpected ? ' (content verified)' : ''}`);
      } else {
        results.push({ page: nav, view, status: 'NAV_NOT_FOUND' });
        console.log(`${num}. ${nav.padEnd(15)} → NAV BUTTON NOT FOUND`);
      }
    } catch (err) {
      results.push({ page: nav, view, status: 'ERROR', error: err.message });
      console.log(`${num}. ${nav.padEnd(15)} → ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('E2E TEST SUMMARY');
  console.log('='.repeat(60));

  const ok = results.filter(r => r.status === 'OK').length;
  const placeholder = results.filter(r => r.status === 'PLACEHOLDER').length;
  const errors = results.filter(r => r.status === 'ERROR').length;
  const notFound = results.filter(r => r.status === 'NAV_NOT_FOUND').length;
  const empty = results.filter(r => r.status === 'EMPTY').length;

  console.log(`OK:          ${ok}/${PAGES.length}`);
  console.log(`Placeholder: ${placeholder}`);
  console.log(`Empty:       ${empty}`);
  console.log(`Errors:      ${errors}`);
  console.log(`Nav Missing: ${notFound}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}/`);

  if (errors > 0) {
    console.log('\nFailed pages:');
    results.filter(r => r.status === 'ERROR').forEach(r => {
      console.log(`  - ${r.page}: ${r.error || 'unknown error'}`);
    });
  }

  await browser.close();
  console.log('\nBrowser closed. Done.');
}

run().catch(err => {
  console.error('E2E test failed:', err);
  process.exit(1);
});

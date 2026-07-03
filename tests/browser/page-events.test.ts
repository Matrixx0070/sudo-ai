/**
 * @file page-events.test.ts
 * @description Real-browser e2e for network/console capture. Spins up a tiny HTTP
 * server that returns a page with a console.log, a console.error, a thrown error,
 * and an image that 404s — then asserts the buffers captured all of it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { browserAvailable } from './_browser-available.js';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { ensureCapture, getNetwork, getConsole } from '../../src/core/tools/builtin/browser/page-events.js';

describe.skipIf(!browserAvailable())('page-events capture (real browser)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/missing.png') {
        res.statusCode = 404;
        res.end('nope');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html><body>
        <img src="/missing.png" />
        <script>
          console.log('hello from page');
          console.error('boom error');
          throw new Error('uncaught page error');
        </script>
      </body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    ensureCapture(context); // start capture BEFORE navigation
    const page = await context.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForTimeout(150); // let 404 + console events flush
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('captures the document response and the 404 image', () => {
    const net = getNetwork(context);
    expect(net.some((e) => e.url === base + '/' && e.status === 200)).toBe(true);
    expect(net.some((e) => e.url.endsWith('/missing.png') && e.status === 404)).toBe(true);
  });

  it('filters to failed/4xx entries', () => {
    const failed = getNetwork(context, { onlyFailed: true });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((e) => e.failed || e.status >= 400)).toBe(true);
    expect(failed.some((e) => e.url.endsWith('/missing.png'))).toBe(true);
  });

  it('captures console.log, console.error, and the uncaught page error', () => {
    const all = getConsole(context);
    expect(all.some((e) => e.type === 'log' && e.text.includes('hello from page'))).toBe(true);
    const errs = getConsole(context, { onlyErrors: true });
    expect(errs.some((e) => e.type === 'error' && e.text.includes('boom error'))).toBe(true);
    expect(errs.some((e) => e.type === 'pageerror' && e.text.includes('uncaught page error'))).toBe(true);
  });
});

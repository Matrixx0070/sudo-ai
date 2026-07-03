/**
 * @file tool-router-browser-snapshot.test.ts
 * @description Regression: browser.snapshot must always be routable. It was
 * intermittently dropped because the browser category (22 tools) was capped at 8
 * and snapshot wasn't a base tool — so the stable-ref workflow was silently
 * unreachable a fraction of the time (proven: a prompt literally naming
 * browser.snapshot still excluded it). Fixed by making it a base tool + raising
 * the browser category cap.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { registerBrowserTools } from '../../src/core/tools/builtin/browser/index.js';
import { ToolRouter } from '../../src/core/agent/tool-router.js';

function names(schemas: Array<{ function?: { name?: string }; name?: string }>): string[] {
  return schemas.map((s) => s.function?.name ?? s.name).filter((n): n is string => !!n);
}

describe('tool-router exposes browser.snapshot', () => {
  const reg = new ToolRegistry();
  registerBrowserTools(reg);
  const router = new ToolRouter(reg);

  it('is a base tool — present even on a non-browser prompt', () => {
    const routed = names(router.route('what should I cook for dinner tonight', []));
    expect(routed).toContain('browser.snapshot');
  });

  it('is present on the exact prompt that used to drop it', () => {
    const routed = names(router.route(
      'Open https://en.wikipedia.org/wiki/Web_browser and call browser.snapshot and tell me how many actionable elements it lists.',
      [],
    ));
    expect(routed).toContain('browser.snapshot');
  });

  it('the core browsing workflow travels together on a browsing prompt', () => {
    const routed = names(router.route(
      'navigate to the login page, snapshot it, then click the sign-in button and type my email',
      [],
    ));
    for (const t of ['browser.snapshot', 'browser.navigate', 'browser.click', 'browser.type']) {
      expect(routed, `expected ${t}`).toContain(t);
    }
  });
});

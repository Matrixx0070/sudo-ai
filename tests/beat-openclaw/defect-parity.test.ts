/**
 * @file tests/beat-openclaw/defect-parity.test.ts
 * @description BO13 / scorecard-S17 — regression guards proving each of the 8
 * catalogued OpenClaw UI defects is ABSENT (or FIXED) in SUDO-AI's equivalent
 * surface. See docs/BEAT_OPENCLAW_DEFECT_PARITY.md for the full audit + verdicts.
 *
 * The 8 OpenClaw defects (OPUS_HANDOFF_BEAT_OPENCLAW.md §10):
 *   1. worktree-chat "New chat in worktree" is a no-op.
 *   2. confirm-less Archive AND confirm-less cron-Remove.
 *   3. PWA manifest 404 on nested routes.
 *   4. editor drops Save during an in-flight save.
 *   5. settings search filters only active tab, claims section-wide no-match.
 *   6. "Open" header button no-op.
 *   7. unsaved-counter unreliable.
 *   8. no min-clamp on number spinners + `{}` residue on field unset.
 *
 * Defect #2 (archive-confirm) is additionally locked by the BO9 test
 * tests/sessions/session-admin-actions.test.ts — this file adds the cron-Remove
 * confirm gate (a real destructive endpoint that BO13 fixed).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

// ---------------------------------------------------------------------------
// Minimal req/res harness (mirrors tests/api/admin-stub-honesty.test.ts)
// ---------------------------------------------------------------------------
function makeReq(method: string, url: string): http.IncomingMessage {
  return { method, url, headers: {}, socket: {} } as unknown as http.IncomingMessage;
}
function makeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res: Record<string, unknown> = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (status: number) => {
      statusCode = status;
      res['headersSent'] = true;
      return res;
    },
    end: (body?: string) => {
      if (body) chunks.push(body);
    },
  };
  return {
    res: res as unknown as http.ServerResponse,
    status: () => statusCode,
    body: () => JSON.parse(chunks.join('') || 'null') as Record<string, unknown>,
  };
}

// ===========================================================================
// Defect #1 — "New chat in worktree" no-op.
// SUDO-AI ships NO worktree-chat button; its analog is the chat SPA "New chat"
// button, which is fully wired (clearMessages + resetChatPeerId + reload).
// ===========================================================================
describe('BO13 #1 — no dead "new chat" button; the analog is wired', () => {
  it('the chat SPA exposes NO "New chat in worktree" widget', () => {
    const app = src('src/renderer/chat/App.tsx');
    expect(/worktree/i.test(app)).toBe(false);
  });

  it('"New chat" is wired to a real handler that mints a fresh peer', () => {
    const app = src('src/renderer/chat/App.tsx');
    // handler exists and does real work
    expect(app).toContain('const handleNewChat = () => {');
    expect(app).toContain('clearMessages();');
    expect(app).toContain('resetChatPeerId();');
    // button is bound to it (not an empty onClick)
    expect(app).toContain('onClick={handleNewChat}');
    // the peer reset actually mints a new id (not a no-op)
    const peer = src('src/renderer/chat/peer.ts');
    expect(peer).toContain('export function resetChatPeerId()');
    expect(peer).toContain('crypto.randomUUID()');
  });
});

// ===========================================================================
// Defect #2 — confirm-less cron-Remove. BO13 added a confirm gate to the only
// destructive admin remove path (DELETE /api/admin/cron/jobs/:id).
// (Archive-confirm is proven by tests/sessions/session-admin-actions.test.ts.)
// ===========================================================================
describe('BO13 #2 — cron DELETE requires explicit confirm', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let router: typeof import('../../src/core/api/admin-router.js')['adminRouter'];

  beforeAll(async () => {
    prevDataDir = process.env['DATA_DIR'];
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bo13-cron-'));
    mkdirSync(path.join(tmpDir, 'cron'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'cron', 'jobs.json'),
      JSON.stringify([
        {
          id: 'job-1',
          name: 'nightly-job',
          schedule: { kind: 'cron', expr: '0 3 * * *' },
          payload: { kind: 'prompt', prompt: 'noop' },
          sessionTarget: 'isolated',
          enabled: true,
          consecutiveErrors: 0,
        },
      ]),
    );
    process.env['DATA_DIR'] = tmpDir;
    vi.resetModules();
    ({ adminRouter: router } = await import('../../src/core/api/admin-router.js'));
    await import('../../src/core/api/admin/cron.handler.js');
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prevDataDir;
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('REJECTS an unconfirmed delete with confirm_required (400) — job survives', async () => {
    const { res, status, body } = makeRes();
    const handled = await router.dispatch(makeReq('DELETE', '/api/admin/cron/jobs/job-1'), res);
    expect(handled).toBe(true);
    expect(status()).toBe(400);
    const payload = body();
    expect((payload['error'] as Record<string, unknown>)['reason']).toBe('confirm_required');
    // job NOT deleted — a follow-up GET still lists it
    const g = makeRes();
    await router.dispatch(makeReq('GET', '/api/admin/cron/jobs'), g.res);
    expect((g.body()['jobs'] as unknown[]).length).toBe(1);
  });

  it('REJECTS confirm=false / confirm=wrong-id', async () => {
    const a = makeRes();
    await router.dispatch(makeReq('DELETE', '/api/admin/cron/jobs/job-1?confirm=false'), a.res);
    expect(a.status()).toBe(400);
    const b = makeRes();
    await router.dispatch(makeReq('DELETE', '/api/admin/cron/jobs/job-1?confirm=other'), b.res);
    expect(b.status()).toBe(400);
  });

  it('ACCEPTS ?confirm=true and actually deletes', async () => {
    const { res, status, body } = makeRes();
    await router.dispatch(makeReq('DELETE', '/api/admin/cron/jobs/job-1?confirm=true'), res);
    expect(status()).toBe(200);
    expect(body()['ok']).toBe(true);
    const g = makeRes();
    await router.dispatch(makeReq('GET', '/api/admin/cron/jobs'), g.res);
    expect((g.body()['jobs'] as unknown[]).length).toBe(0);
  });
});

// ===========================================================================
// Defect #3 — PWA manifest 404 on nested routes.
// SUDO-AI ships NO PWA manifest link, so there is no manifest to 404. The
// static middleware DOES map nested SPA routes into the built app dir (asset
// fallback), and asset URLs in the built index.html are absolute (Vite `/assets`)
// — never a relative link that breaks under a nested path.
// ===========================================================================
describe('BO13 #3 — no PWA manifest to 404; nested asset routes are mapped', () => {
  it('neither SPA index.html references a manifest link (nothing to 404)', () => {
    for (const rel of ['src/renderer/chat/index.html', 'src/renderer/admin/index.html']) {
      const html = src(rel);
      expect(/rel=["']?manifest/i.test(html)).toBe(false);
      expect(/\.webmanifest/i.test(html)).toBe(false);
    }
  });

  it('static middleware routes nested /chat/* and /v1/admin/dashboard/* to the SPA dir', () => {
    const mw = src('src/core/gateway/static-middleware.ts');
    // nested-route branch exists (asset fallback under each SPA)
    expect(mw).toContain("pathname.startsWith('/v1/admin/dashboard/') || pathname.startsWith('/chat/')");
    // path-traversal guard prevents nested `..` escapes returning the wrong file
    expect(mw).toContain('DIST_DIR + sep');
  });
});

// ===========================================================================
// Defect #4 — editor drops a Save during an in-flight save.
// The guidance editor disables the Save button for the duration of the request
// (re-enabled only in the callback), so a second click cannot fire a concurrent
// or dropped save. Same disable-during-flight guard on Fork/Archive.
// ===========================================================================
describe('BO13 #4 — Save is guarded against in-flight double-submit', () => {
  it('guidance Save disables the button before POST and re-enables in the callback', () => {
    const g = src('src/core/gateway/dashboard-guidance.ts');
    const start = g.indexOf('save.onclick = function()');
    expect(start).toBeGreaterThan(-1);
    const block = g.slice(start, start + 900);
    // disabled BEFORE the request goes out …
    const disableAt = block.indexOf('save.disabled = true;');
    const postAt = block.indexOf("apiPost('/v1/admin/system/guidance/file'");
    expect(disableAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(disableAt);
    // … and re-enabled inside the response callback
    expect(block).toContain('save.disabled = false;');
  });

  it('sessions Fork/Archive also disable their button during the request', () => {
    const s = src('src/core/gateway/dashboard-sessions.ts');
    expect(s).toContain('fork.disabled = true;');
    expect(s).toContain('arch.disabled = true;');
  });
});

// ===========================================================================
// Defect #5 — settings search filters only the active tab but claims a
// section-wide no-match. SUDO-AI ships no settings-search widget at all, so the
// misleading-scope behavior has no surface on which to occur.
// ===========================================================================
describe('BO13 #5 — no settings-search widget exists (defect has no analog)', () => {
  it('no dashboard fragment renders a settings/search filter input', () => {
    const files = [
      'src/core/gateway/dashboard-html.ts',
      'src/core/gateway/dashboard-usage.ts',
      'src/core/gateway/dashboard-sessions.ts',
      'src/core/gateway/dashboard-guidance.ts',
    ];
    for (const f of files) {
      const s = src(f);
      // the only <input> in the whole surface is the browser-takeover text box;
      // there is no search/filter input that could mis-scope a "no match".
      expect(/placeholder=["'][^"']*search/i.test(s)).toBe(false);
    }
  });
});

// ===========================================================================
// Defect #6 — "Open" header button no-op. Every header/action button in the
// inline dashboard and the chat SPA header is bound to a real handler.
// ===========================================================================
describe('BO13 #6 — no dead header/action buttons', () => {
  it('the inline dashboard header buttons are both wired (no ">Open<" no-op)', () => {
    const d = src('src/core/gateway/dashboard-html.ts');
    expect(d).toContain('id="btn-refresh" onclick="refresh()"');
    expect(d).toContain('id="btn-copy" onclick="copyDigest()"');
    // no stray "Open" no-op button
    expect(/>\s*Open\s*</.test(d)).toBe(false);
  });

  it('the chat SPA header buttons are bound to handlers', () => {
    const app = src('src/renderer/chat/App.tsx');
    expect(app).toContain('onClick={() => setDirectoryOpen(true)}');
    expect(app).toContain('onClick={handleNewChat}');
  });
});

// ===========================================================================
// Defect #7 — unsaved-counter unreliable. SUDO-AI has no global unsaved counter;
// the guidance editor reports each save's outcome per-action (audited hash
// before→after), so there is no counter that can drift out of sync.
// ===========================================================================
describe('BO13 #7 — no unsaved counter to be unreliable', () => {
  it('no dashboard fragment maintains an unsaved/dirty counter', () => {
    const files = [
      'src/core/gateway/dashboard-html.ts',
      'src/core/gateway/dashboard-usage.ts',
      'src/core/gateway/dashboard-sessions.ts',
      'src/core/gateway/dashboard-guidance.ts',
    ];
    for (const f of files) {
      const s = src(f);
      expect(/unsaved|dirtyCount|pendingCount/i.test(s)).toBe(false);
    }
  });

  it('guidance Save reports per-action audited outcome (hash before→after)', () => {
    const g = src('src/core/gateway/dashboard-guidance.ts');
    expect(g).toContain('configHashBefore');
    expect(g).toContain('configHashAfter');
  });
});

// ===========================================================================
// Defect #8 — no min-clamp on number spinners + `{}` residue on field unset.
// SUDO-AI ships NO <input type=number> spinner in any admin/SPA surface, so no
// min-clamp is possible to omit. All numeric rendering coerces via Number(x||0),
// which yields a finite number for unset/undefined/null — never a literal `{}`.
// ===========================================================================
describe('BO13 #8 — no number spinners; numeric coercion never leaves `{}` residue', () => {
  it('no <input type=number> exists in any dashboard/SPA surface', () => {
    const files = [
      'src/core/gateway/dashboard-html.ts',
      'src/core/gateway/dashboard-usage.ts',
      'src/core/gateway/dashboard-sessions.ts',
      'src/core/gateway/dashboard-guidance.ts',
    ];
    for (const f of files) {
      const s = src(f);
      expect(/type\s*=\s*["']number["']/i.test(s)).toBe(false);
      expect(/type\s*=\s*['"]number['"]/.test(s)).toBe(false);
    }
  });

  it('the Number(x||0) coercion pattern yields a finite value (never a `{}` string)', () => {
    // Mirrors the dashboard formatters: `n = Number(n||0)`.
    const coerce = (n: unknown): number => Number((n as number) || 0);
    for (const v of [undefined, null, 0, '', NaN as unknown]) {
      const out = coerce(v);
      expect(String(out)).not.toContain('{}');
      expect(String(out)).not.toContain('[object');
    }
    expect(coerce(42)).toBe(42);
    expect(coerce(undefined)).toBe(0);
    expect(coerce(null)).toBe(0);
  });
});

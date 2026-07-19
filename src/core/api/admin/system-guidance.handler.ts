/**
 * @file admin/system-guidance.handler.ts
 * @description BO10 / scorecard-S10 — admin API for the guidance-file viewer +
 * gated, hash-audited writer rendered by the inline admin dashboard.
 *
 * Routes (served canonically under /v1/admin/system/*):
 *   GET  /api/admin/system/guidance             list + per-file frozen flag
 *   GET  /api/admin/system/guidance/file?name=  read one file's content
 *   POST /api/admin/system/guidance/file        gated audited write { name, content }
 *
 * INVARIANT 4 — the WRITE endpoint hard-rejects frozen files (PROTECTED_PATHS +
 * identity/constitution surfaces) with 403 even if the UI is bypassed. Frozen
 * files are read-only, ALWAYS: the list marks them, the reader shows them, the
 * writer refuses them (`resolveGuidanceSpec` allow-list blocks path traversal;
 * `isFrozenGuidanceSpec` blocks frozen writes; `writeGuidanceAudited` re-checks
 * both as defense in depth). Non-frozen writes are hash-audited (.bak + before/
 * after sha256 in data/guidance-audit.jsonl).
 *
 * S15/S16 untouched: reads are unconditional; the only writes are hash-audited,
 * path-guarded, non-frozen guidance files.
 */

import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import {
  listGuidanceSpecs,
  resolveGuidanceSpec,
  isFrozenGuidanceSpec,
} from '../../workspace/guidance-registry.js';
import { readGuidance, writeGuidanceAudited } from './guidance-io.js';

const log = createLogger('api:admin:system-guidance');

async function parseBody(
  req: Parameters<typeof readJsonBody>[0],
): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/system/guidance — list + frozen flag per file
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/system/guidance', async (_req, res) => {
  try {
    const files = listGuidanceSpecs().map((s) => {
      const r = readGuidance(s);
      return {
        name: s.name,
        label: s.label,
        relPath: s.relPath,
        category: s.category,
        frozen: s.frozen,
        exists: r.exists,
        bytes: r.bytes,
        sha256: r.sha256,
        lastModified: r.lastModified,
      };
    });
    const frozenCount = files.filter((f) => f.frozen).length;
    sendJson(res, 200, {
      ok: true,
      data: { files, count: files.length, frozenCount, editableCount: files.length - frozenCount },
    });
  } catch (err) {
    log.warn({ err: String(err) }, 'GET system/guidance failed');
    sendJson(res, 200, { ok: false, error: 'guidance list unavailable' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/system/guidance/file?name=SOUL — read one file
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/system/guidance/file', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const spec = resolveGuidanceSpec(url.searchParams.get('name'));
  if (!spec) {
    sendJson(res, 404, { ok: false, error: { message: 'Unknown guidance file', code: 404 } });
    return;
  }
  try {
    const r = readGuidance(spec);
    sendJson(res, 200, { ok: true, data: r });
  } catch (err) {
    log.warn({ err: String(err), name: spec.name }, 'GET system/guidance/file failed');
    sendJson(res, 500, { ok: false, error: { message: 'Failed to read guidance file', code: 500 } });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/system/guidance/file — gated, hash-audited write
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/system/guidance/file', async (req, res) => {
  const body = await parseBody(req);
  if (!body) {
    sendJson(res, 400, { ok: false, error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }
  // Traversal guard: only allow-listed catalog names resolve.
  const spec = resolveGuidanceSpec(body['name']);
  if (!spec) {
    sendJson(res, 404, { ok: false, error: { message: 'Unknown guidance file', code: 404 } });
    return;
  }
  // INVARIANT 4: frozen files are read-only, ALWAYS — reject at the handler even
  // if the UI never offered an edit box (defense in depth).
  if (isFrozenGuidanceSpec(spec)) {
    log.warn({ name: spec.name, relPath: spec.relPath }, 'REJECTED frozen guidance write (invariant 4)');
    sendJson(res, 403, {
      ok: false,
      code: 'frozen',
      error: { message: `Frozen file is read-only: ${spec.label}`, code: 403 },
    });
    return;
  }
  const content = body['content'];
  if (typeof content !== 'string') {
    sendJson(res, 400, { ok: false, error: { message: 'content must be a string', code: 400 } });
    return;
  }
  try {
    const audit = writeGuidanceAudited({ spec, content, actor: 'admin' });
    log.info({ name: spec.name, before: audit.configHashBefore, after: audit.configHashAfter }, 'guidance write (audited)');
    sendJson(res, 200, { ok: true, data: audit });
  } catch (err) {
    // A frozen/traversal error here is a belt-and-braces 403; other errors 500.
    const msg = String(err instanceof Error ? err.message : err);
    const frozenOrGuard = msg.includes('read-only') || msg.includes('escapes root');
    const code = frozenOrGuard ? 403 : 500;
    log.warn({ err: msg, name: spec.name }, 'guidance write failed');
    sendJson(res, code, { ok: false, error: { message: frozenOrGuard ? msg : 'Failed to write guidance file', code } });
  }
});

/**
 * Unit tests for serveStaticFile path-traversal guard.
 *
 * Hermetic: every assertion exercises the guard or route mapping, which run
 * before any disk access, so no dist/renderer build is required (CI runs
 * tests before build).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveStaticFile } from '../../src/core/gateway/static-middleware.js';

interface MockRes {
  res: ServerResponse;
  statusCode: () => number | undefined;
}

function makeRes(): MockRes {
  let status: number | undefined;
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as ServerResponse;
  return { res, statusCode: () => status };
}

const req = {} as IncomingMessage;

describe('serveStaticFile path-traversal guard', () => {
  let savedNoStatic: string | undefined;

  beforeEach(() => {
    savedNoStatic = process.env['SUDO_NO_STATIC'];
    delete process.env['SUDO_NO_STATIC'];
  });

  afterEach(() => {
    if (savedNoStatic === undefined) delete process.env['SUDO_NO_STATIC'];
    else process.env['SUDO_NO_STATIC'] = savedNoStatic;
  });

  it('rejects traversal escaping the dist root with 403', () => {
    const { res, statusCode } = makeRes();
    const handled = serveStaticFile(req, res, '/chat/../../../../etc/passwd');
    expect(handled).toBe(true);
    expect(statusCode()).toBe(403);
  });

  it('rejects sibling-directory prefix collision (dist/renderer-evil) with 403', () => {
    const { res, statusCode } = makeRes();
    // join(DIST_DIR, 'chat', '../../renderer-evil/x') resolves to
    // dist/renderer-evil/x — a string prefix of DIST_DIR without the separator.
    const handled = serveStaticFile(req, res, '/chat/../../renderer-evil/x.js');
    expect(handled).toBe(true);
    expect(statusCode()).toBe(403);
  });

  it('rejects a path resolving to exactly DIST_DIR with 403', () => {
    const { res, statusCode } = makeRes();
    const handled = serveStaticFile(req, res, '/chat/..');
    expect(handled).toBe(true);
    expect(statusCode()).toBe(403);
  });

  it('passes the guard for a valid asset path (falls through when file absent)', () => {
    const { res, statusCode } = makeRes();
    const handled = serveStaticFile(req, res, '/chat/assets/definitely-not-real-xyz.js');
    expect(handled).toBe(false);
    expect(statusCode()).toBeUndefined();
  });

  it('ignores unrelated pathnames', () => {
    const { res, statusCode } = makeRes();
    const handled = serveStaticFile(req, res, '/v1/messages');
    expect(handled).toBe(false);
    expect(statusCode()).toBeUndefined();
  });
});

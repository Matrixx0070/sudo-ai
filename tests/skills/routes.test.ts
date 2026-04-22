/**
 * Route integration tests for /v1/skills endpoints (Wave 5 P2)
 *
 * Uses a real http.Server on a random port + native fetch.
 * An in-memory SkillRegistry is wired in for full request/response testing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SkillRegistry } from '../../src/core/skills/registry.js';
import { registerSkillRoutes } from '../../src/core/skills/routes.js';

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

let baseUrl: string;
let server: http.Server;
let registry: SkillRegistry;
let db: InstanceType<typeof Database>;
let skillsDir: string;

// Helper: write a skill file
function writeSkill(name: string, content: string): void {
  writeFileSync(join(skillsDir, `${name}.md`), content, 'utf8');
}

const SKILL_CONTENT = (name: string) => `---
name: ${name}
description: Test skill ${name}
trigger: /${name}
allowed-tools: [read]
---

# ${name}
This is the body of ${name}.
`;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  skillsDir = join(tmpdir(), `skills-routes-test-${randomUUID()}`);
  mkdirSync(skillsDir, { recursive: true });

  // Pre-populate 2 skills
  writeSkill('alpha', SKILL_CONTENT('alpha'));
  writeSkill('beta', SKILL_CONTENT('beta'));

  registry = new SkillRegistry(db, skillsDir);
  registry.scanAndRegister();

  server = http.createServer();
  registerSkillRoutes(server, registry);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  db.close();
  rmSync(skillsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${baseUrl}${path}`, opts);
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}

// ---------------------------------------------------------------------------
// GET /v1/skills
// ---------------------------------------------------------------------------

describe('GET /v1/skills', () => {
  it('returns 200 with list of skills (meta only)', async () => {
    const { status, json } = await req('GET', '/v1/skills');
    expect(status).toBe(200);
    const body = json as { data: unknown[]; limit: number; offset: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('returns meta fields without body_md', async () => {
    const { json } = await req('GET', '/v1/skills');
    const body = json as { data: Record<string, unknown>[] };
    const first = body.data[0]!;
    expect(first['name']).toBeTruthy();
    expect(first['version']).toBeTruthy();
    expect('body_md' in first).toBe(false);
  });

  it('respects limit query param', async () => {
    const { json } = await req('GET', '/v1/skills?limit=1');
    const body = json as { data: unknown[] };
    expect(body.data.length).toBe(1);
  });

  it('returns 404 for completely unknown path under /v1/skills', async () => {
    const { status } = await req('GET', '/v1/skills/x/y/z/deep');
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/skills/:id
// ---------------------------------------------------------------------------

describe('GET /v1/skills/:id', () => {
  it('returns 200 with full skill including body_md', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    const { status, json } = await req('GET', `/v1/skills/${id}`);
    expect(status).toBe(200);
    const skill = json as Record<string, unknown>;
    expect(skill['id']).toBe(id);
    expect(typeof skill['body_md']).toBe('string');
  });

  it('returns 404 for unknown skill id', async () => {
    const { status } = await req('GET', '/v1/skills/does-not-exist');
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/skills/:id/versions
// ---------------------------------------------------------------------------

describe('GET /v1/skills/:id/versions', () => {
  it('returns 200 with version list', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    const { status, json } = await req('GET', `/v1/skills/${id}/versions`);
    expect(status).toBe(200);
    const vers = json as { data: unknown[] };
    expect(Array.isArray(vers.data)).toBe(true);
    expect(vers.data.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 when skill id unknown', async () => {
    const { status } = await req('GET', '/v1/skills/unknown-xyz/versions');
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/skills/:id/attach
// ---------------------------------------------------------------------------

describe('POST /v1/skills/:id/attach', () => {
  it('attaches a skill to a session and returns 200', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    const { status, json } = await req(
      'POST',
      `/v1/skills/${id}/attach`,
      { sessionId: 'test-session-1' },
      { 'X-Session-Id': 'test-session-1' },
    );
    expect(status).toBe(200);
    const result = json as Record<string, unknown>;
    expect(result['skill_id']).toBe(id);
    expect(result['session_id']).toBe('test-session-1');
  });

  it('returns 400 when sessionId is missing', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    // Even with X-Session-Id header, missing body sessionId returns 400
    const { status } = await req(
      'POST',
      `/v1/skills/${id}/attach`,
      {},
      { 'X-Session-Id': 'some-session' },
    );
    expect(status).toBe(400);
  });

  it('returns 400 when X-Session-Id header is missing', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    const { status } = await req('POST', `/v1/skills/${id}/attach`, {
      sessionId: 'sess-z',
    });
    expect(status).toBe(400);
  });

  it('returns 404 when skill id not found', async () => {
    const { status } = await req(
      'POST',
      '/v1/skills/no-such-skill/attach',
      { sessionId: 'sess-z' },
      { 'X-Session-Id': 'sess-z' },
    );
    expect(status).toBe(404);
  });

  it('returns 422 when 20-skill cap is exceeded', async () => {
    // Register 20 more unique skills via the registry directly
    for (let i = 0; i < 20; i++) {
      writeSkill(`cap-route-${i}`, SKILL_CONTENT(`cap-route-${i}`));
    }
    registry.scanAndRegister();

    const { json: list } = await req('GET', '/v1/skills?limit=50');
    const allSkills = (list as { data: Array<{ id: string }> }).data;

    const capSession = `cap-session-${randomUUID()}`;
    let attached = 0;
    let capStatus = 0;

    for (const skill of allSkills) {
      const { status } = await req(
        'POST',
        `/v1/skills/${skill.id}/attach`,
        { sessionId: capSession },
        { 'X-Session-Id': capSession },
      );
      if (status === 200) {
        attached++;
      } else if (status === 422) {
        capStatus = status;
        break;
      }
    }

    expect(attached).toBe(20);
    expect(capStatus).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/skills/:id/detach
// ---------------------------------------------------------------------------

describe('POST /v1/skills/:id/detach', () => {
  it('detaches a skill from session and returns 200', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    await req(
      'POST',
      `/v1/skills/${id}/attach`,
      { sessionId: 'detach-session' },
      { 'X-Session-Id': 'detach-session' },
    );
    const { status, json } = await req(
      'POST',
      `/v1/skills/${id}/detach`,
      { sessionId: 'detach-session' },
      { 'X-Session-Id': 'detach-session' },
    );
    expect(status).toBe(200);
    const result = json as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it('returns 400 when sessionId is missing', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    // X-Session-Id present but body has no sessionId
    const { status } = await req(
      'POST',
      `/v1/skills/${id}/detach`,
      {},
      { 'X-Session-Id': 'some-session' },
    );
    expect(status).toBe(400);
  });

  it('returns 400 when X-Session-Id header is missing', async () => {
    const { json: list } = await req('GET', '/v1/skills');
    const body = list as { data: Array<{ id: string }> };
    const id = body.data[0]!.id;
    const { status } = await req('POST', `/v1/skills/${id}/detach`, {
      sessionId: 'detach-session-2',
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/skills/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/skills/:id', () => {
  it('archives a skill and returns 200', async () => {
    // Register a temp skill for deletion
    writeSkill('deletable', SKILL_CONTENT('deletable'));
    registry.scanAndRegister();
    const meta = registry.getSkillMeta('deletable')!;

    const { status, json } = await req('DELETE', `/v1/skills/${meta.id}`);
    expect(status).toBe(200);
    const result = json as { ok: boolean; archived: boolean };
    expect(result.archived).toBe(true);
  });

  it('returns 404 when skill id not found', async () => {
    const { status } = await req('DELETE', '/v1/skills/ghost-id');
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Security: Fix 2 — negative offset returns offset=0 results (not a full scan)
// ---------------------------------------------------------------------------

describe('GET /v1/skills — negative offset clamping (Fix 2)', () => {
  it('?offset=-1 returns 200 with clamped offset=0 results', async () => {
    const { status, json } = await req('GET', '/v1/skills?offset=-1');
    expect(status).toBe(200);
    const body = json as { data: unknown[]; offset: number };
    // offset in response should be 0 (clamped), not -1
    expect(body.offset).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('?limit=-5 is clamped to 1', async () => {
    const { status, json } = await req('GET', '/v1/skills?limit=-5');
    expect(status).toBe(200);
    const body = json as { data: unknown[]; limit: number };
    expect(body.limit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Security: Fix 5 — IDOR: session-nonexistent returns 404
// ---------------------------------------------------------------------------

describe('POST /v1/skills/:id/attach — session store checks (Fix 5)', () => {
  it('returns 404 when session does not exist (sessionStore wired)', async () => {
    // Create a server with a mock sessionStore that always returns undefined
    const mockStore = { getSession: (_id: string) => undefined };

    const db2 = new Database(':memory:');
    db2.pragma('journal_mode = WAL');
    const dir2 = join(tmpdir(), `skills-idor-test-${randomUUID()}`);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 'skill-idor.md'), SKILL_CONTENT('skill-idor'), 'utf8');
    const registry2 = new SkillRegistry(db2, dir2);
    registry2.scanAndRegister();

    const server2 = http.createServer();
    // Wire routes WITH a session store that reports no sessions exist
    const { registerSkillRoutes: rsr } = await import('../../src/core/skills/routes.js');
    rsr(server2, registry2, mockStore);

    const port = await new Promise<number>((resolve) => {
      server2.listen(0, '127.0.0.1', () => {
        resolve((server2.address() as { port: number }).port);
      });
    });
    const base2 = `http://127.0.0.1:${port}`;

    const skillId = registry2.getSkillMeta('skill-idor')!.id;
    const response = await fetch(`${base2}/v1/skills/${skillId}/attach`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': 'nonexistent-session',
      },
      body: JSON.stringify({ sessionId: 'nonexistent-session' }),
    });

    expect(response.status).toBe(404);

    await new Promise<void>((resolve, reject) =>
      server2.close((err) => (err ? reject(err) : resolve())),
    );
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});

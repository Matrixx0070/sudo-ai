/** Scripted flaky mock service (ADR-0007 fault injection, service level). */
import { describe, it, expect } from 'vitest';
import { startMockService } from '../../../src/core/eval/sandbox/mock-service.js';

describe('startMockService', () => {
  it('fails the first N requests with 500 then serves the body', async () => {
    const svc = await startMockService({ failuresBeforeSuccess: 2, successBody: 'FLAG-1' });
    try {
      expect((await fetch(svc.url)).status).toBe(500);
      expect((await fetch(svc.url)).status).toBe(500);
      const ok = await fetch(svc.url);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('FLAG-1');
      expect(svc.requestCount()).toBe(3);
    } finally {
      await svc.close();
    }
  });

  it('failuresBeforeSuccess=0 succeeds immediately', async () => {
    const svc = await startMockService({ failuresBeforeSuccess: 0, successBody: 'ok' });
    try {
      const r = await fetch(svc.url);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('ok');
    } finally {
      await svc.close();
    }
  });
});

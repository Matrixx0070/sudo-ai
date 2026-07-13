/**
 * CanvasStateStore (Spec 2) — save/get/clear + list() for the /admin monitor.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { CanvasStateStore } from '../../src/core/canvas/canvas-store.js';
import type { CanvasPayload } from '../../src/core/canvas/schema.js';

function store() {
  return new CanvasStateStore(new Database(':memory:'));
}
const p = (title: string): CanvasPayload => ({ version: 1, title, components: [{ type: 'text', text: 'x' }] });

describe('CanvasStateStore', () => {
  it('save then get round-trips the payload', () => {
    const s = store();
    s.save('sess-a', p('Alpha'));
    expect(s.get('sess-a')?.title).toBe('Alpha');
  });

  it('save upserts (one row per session)', () => {
    const s = store();
    s.save('sess-a', p('First'));
    s.save('sess-a', p('Second'));
    expect(s.get('sess-a')?.title).toBe('Second');
    expect(s.list(50).filter((r) => r.sessionId === 'sess-a')).toHaveLength(1);
  });

  it('clear removes the session', () => {
    const s = store();
    s.save('sess-a', p('Alpha'));
    s.clear('sess-a');
    expect(s.get('sess-a')).toBeNull();
  });

  it('list returns saved canvases with payload + caps the limit', () => {
    const s = store();
    s.save('sess-a', p('Alpha'));
    s.save('sess-b', p('Beta'));
    const all = s.list(50);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.payload.title).sort()).toEqual(['Alpha', 'Beta']);
    // limit is clamped to >= 1 (0 becomes 1)
    expect(s.list(0).length).toBeLessThanOrEqual(1);
  });

  it('missing session get returns null (fail-open)', () => {
    expect(store().get('nope')).toBeNull();
  });
});

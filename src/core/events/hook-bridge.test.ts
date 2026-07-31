import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookManager } from '../hooks/index.js';
import { EventBus } from './bus.js';
import { initHookBridge } from './hook-bridge.js';
import { EventStore } from './store.js';

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}

describe('hook-bridge (HookManager → event bus)', () => {
  let dir: string;
  let store: EventStore;
  let bus: EventBus;
  let hooks: HookManager;
  let seen: { type: string; data: Record<string, unknown> }[];
  let stop: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-hookbridge-'));
    store = new EventStore(join(dir, 'e.db'));
    bus = new EventBus();
    bus.setStore(store);
    seen = [];
    bus.subscribe((e) => seen.push({ type: e.type, data: e.data }));
    hooks = new HookManager();
    stop = initHookBridge(hooks, bus);
  });
  afterEach(() => {
    stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('session:start/end → session.started, message.completed, session.idled', async () => {
    await hooks.emit('session:start', { event: 'session:start', sessionId: 's1', channel: 'web' });
    await hooks.emit('session:end', { event: 'session:end', sessionId: 's1', messageCount: 4 } as never);
    await flush();
    const types = seen.map((e) => e.type);
    expect(types).toContain('session.started');
    expect(types).toContain('message.completed');
    expect(types).toContain('session.idled');
    expect(seen.find((e) => e.type === 'session.started')?.data).toMatchObject({ session_id: 's1', channel: 'web' });
    expect(seen.find((e) => e.type === 'message.completed')?.data).toMatchObject({ message_count: 4 });
    // Persistent → in the event log too.
    expect(store.listEvents({ type: 'session.started' })).toHaveLength(1);
  });

  it('after:tool-call maps success flag to tool.completed / tool.failed', async () => {
    await hooks.emit('after:tool-call', { event: 'after:tool-call', sessionId: 's1', toolName: 'fs.read', success: true } as never);
    await hooks.emit('after:tool-call', { event: 'after:tool-call', sessionId: 's1', toolName: 'web.fetch', success: false } as never);
    await flush();
    expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(['tool.completed', 'tool.failed']));
    expect(seen.find((e) => e.type === 'tool.failed')?.data).toMatchObject({ tool: 'web.fetch' });
  });

  it('on:message publishes metadata only — never the message text', async () => {
    await hooks.emit('on:message', { event: 'on:message', sessionId: 's1', channel: 'telegram', message: 'a very private secret' });
    await flush();
    const evt = seen.find((e) => e.type === 'message.created');
    expect(evt?.data).toMatchObject({ session_id: 's1', channel: 'telegram', length: 21 });
    expect(JSON.stringify(evt)).not.toContain('private secret');
  });

  it('on:error → message.failed with capped error string', async () => {
    await hooks.emit('on:error', { event: 'on:error', sessionId: 's1', error: new Error('x'.repeat(1000)) });
    await flush();
    const evt = seen.find((e) => e.type === 'message.failed');
    expect(String(evt?.data['error']).length).toBeLessThanOrEqual(300);
  });

  it('events route to session channels and stop() detaches all handlers', async () => {
    await hooks.emit('session:start', { event: 'session:start', sessionId: 's9' });
    await flush();
    expect(store.listEvents({ type: 'session.started' })[0]?.channels).toEqual(['session:s9']);
    stop();
    seen.length = 0;
    await hooks.emit('session:start', { event: 'session:start', sessionId: 's9' });
    await flush();
    expect(seen).toHaveLength(0);
  });
});

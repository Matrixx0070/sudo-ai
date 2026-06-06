import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SnapshotEngine } from '../../src/core/tools/builtin/browser/snapshot-engine.js';
import type { CDPManager } from '../../src/core/tools/builtin/browser/cdp-manager.js';

// ---------------------------------------------------------------------------
// Sample CDP AX nodes simulating a small login page
// ---------------------------------------------------------------------------

const SAMPLE_AX_NODES = [
  { nodeId: '1', role: { type: 'role', value: 'navigation' }, name: { type: 'name', value: 'Main Menu' } },
  { nodeId: '2', parentId: '1', role: { type: 'role', value: 'link' }, name: { type: 'name', value: 'Home' }, description: { type: 'desc', value: '/home' } },
  { nodeId: '3', role: { type: 'role', value: 'main' }, name: { type: 'name', value: '' } },
  { nodeId: '4', parentId: '3', role: { type: 'role', value: 'heading' }, name: { type: 'name', value: 'Welcome' } },
  { nodeId: '5', parentId: '3', role: { type: 'role', value: 'form' }, name: { type: 'name', value: 'Login' } },
  { nodeId: '6', parentId: '5', role: { type: 'role', value: 'textbox' }, name: { type: 'name', value: 'Email' }, value: { type: 'value', value: '' } },
  { nodeId: '7', parentId: '5', role: { type: 'role', value: 'button' }, name: { type: 'name', value: 'Sign In' } },
];

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockCDPManager(nodes: any[] = []) {
  const cdpSession = {
    send: vi.fn().mockResolvedValue({ nodes }),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  const mockPage = {
    url: vi.fn().mockReturnValue('https://example.com'),
    title: vi.fn().mockReturnValue('Login Page'),
    context: vi.fn().mockReturnValue({ newCDPSession: vi.fn().mockResolvedValue(cdpSession) }),
    getByRole: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue({
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
  return {
    getActiveSession: vi.fn().mockReturnValue({ id: 's1', targetId: 't1', url: 'https://example.com', state: 'connected', createdAt: new Date().toISOString() }),
    getCDPClient: vi.fn().mockReturnValue({ contexts: vi.fn().mockReturnValue([{ pages: vi.fn().mockReturnValue([mockPage]) }]) }),
    _page: mockPage,
  } as unknown as CDPManager & { _page: any };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SnapshotEngine', () => {
  let engine: SnapshotEngine;

  beforeEach(() => {
    engine = new SnapshotEngine(makeMockCDPManager(SAMPLE_AX_NODES));
  });

  it('numeric snapshot: elements get numbered refs', async () => {
    const result = await engine.capture('numeric');
    expect(result.style).toBe('numeric');
    expect(result.elementCount).toBeGreaterThan(0);
    // Every element should have a unique positive numeric ref
    const refs = result.elements.map(e => e.ref);
    expect(refs.every(r => r >= 1)).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
    // Numeric content uses bracket-style refs and only interactive/heading roles
    // Navigation (ref 1) is structural and excluded from numeric output
    const contentRef = result.elements.find(e => e.role === 'button')!.ref;
    expect(result.content).toContain(`[${contentRef}]`);
    expect(result.content).toContain('button');
    expect(result.content).toContain('textbox');
  });

  it('role snapshot: elements described by ARIA role', async () => {
    const result = await engine.capture('role');
    expect(result.style).toBe('role');
    // Role output labels each line by ARIA role
    expect(result.content).toContain('navigation:');
    expect(result.content).toContain('link:');
    expect(result.content).toContain('button:');
    expect(result.content).toContain('"Sign In"');
  });

  it('ARIA tree snapshot: nested accessibility tree', async () => {
    const result = await engine.capture('aria');
    expect(result.style).toBe('aria');
    // Root wrapped in a document node with the page title
    expect(result.content).toContain('document "Login Page"');
    // Indented children confirm hierarchical nesting
    const lines = result.content.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some(l => l.startsWith('  '))).toBe(true);
  });

  it('find element by ref', async () => {
    const result = await engine.capture('numeric');
    const first = result.elements[0];
    expect(first).toBeDefined();
    const found = engine.findElement(first!.ref);
    expect(found).toBeDefined();
    expect(found!.role).toBe(first!.role);
    expect(engine.findElement(999)).toBeUndefined();
  });

  it('click element by ref', async () => {
    const result = await engine.capture('numeric');
    const btn = result.elements.find(e => e.role === 'button')!;
    expect(btn).toBeDefined();
    await expect(engine.clickElement(btn.ref)).resolves.toBeUndefined();
    // Clicking invalid ref throws
    await expect(engine.clickElement(999)).rejects.toThrow(/not found/);
  });

  it('type into element by ref', async () => {
    const result = await engine.capture('numeric');
    const tb = result.elements.find(e => e.role === 'textbox')!;
    expect(tb).toBeDefined();
    await expect(engine.typeIntoElement(tb.ref, 'user@test.com')).resolves.toBeUndefined();
    // Typing into invalid ref throws
    await expect(engine.typeIntoElement(999, 'x')).rejects.toThrow(/not found/);
  });

  it('stats tracking', async () => {
    await engine.capture('numeric');
    await engine.capture('role');
    await engine.capture('aria');
    const stats = engine.getStats();
    expect(stats.totalCaptures).toBe(3);
    expect(stats.byStyle.numeric).toBe(1);
    expect(stats.byStyle.role).toBe(1);
    expect(stats.byStyle.aria).toBe(1);
    expect(typeof stats.avgElements).toBe('number');
    expect(typeof stats.avgCaptureTimeMs).toBe('number');
  });

  it('empty page: handles no elements', async () => {
    engine = new SnapshotEngine(makeMockCDPManager([]));
    const result = await engine.capture('numeric');
    expect(result.elementCount).toBe(0);
    expect(result.elements).toEqual([]);
    expect(result.content).toBe('');
    expect(engine.findElement(1)).toBeUndefined();
    const stats = engine.getStats();
    expect(stats.totalCaptures).toBe(1);
    expect(stats.avgElements).toBe(0);
  });
});
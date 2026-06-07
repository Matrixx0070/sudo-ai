/**
 * @file bridge-discovery.test.ts
 * @description Tests for IDE Bridge discovery — port file and mDNS.
 *
 * Covers: write/read port file, delete port file, stale PID detection,
 *         BridgeDiscovery lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writePortFile,
  readPortFile,
  deletePortFile,
  isStalePid,
  BridgeDiscovery,
} from '../../src/core/ide/bridge-discovery.js';
import type { BridgeDiscoveryPayload } from '../../shared-types/bridge-protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), 'sudo-ai-bridge-discovery-test');

function makePayload(overrides?: Partial<BridgeDiscoveryPayload>): BridgeDiscoveryPayload {
  return {
    version: 1,
    url: 'http://127.0.0.1:18900',
    wsUrl: 'ws://127.0.0.1:18900/ide/bridge',
    port: 18900,
    pid: process.pid,
    startedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BridgeDiscovery — port file', () => {
  const portFilePath = path.join(TEST_DIR, 'bridge-test.json');

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { fs.unlinkSync(portFilePath); } catch { /* ignore */ }
    try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('writes and reads a port file', () => {
    const payload = makePayload();
    writePortFile(payload, portFilePath);

    expect(fs.existsSync(portFilePath)).toBe(true);

    const read = readPortFile(portFilePath);
    expect(read).not.toBeNull();
    expect(read!.version).toBe(1);
    expect(read!.port).toBe(18900);
    expect(read!.pid).toBe(process.pid);
    expect(read!.wsUrl).toBe('ws://127.0.0.1:18900/ide/bridge');
  });

  it('returns null for non-existent port file', () => {
    const result = readPortFile(path.join(TEST_DIR, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('deletes an existing port file', () => {
    const payload = makePayload();
    writePortFile(payload, portFilePath);
    expect(fs.existsSync(portFilePath)).toBe(true);

    deletePortFile(portFilePath);
    expect(fs.existsSync(portFilePath)).toBe(false);
  });

  it('deletePortFile does not throw on non-existent file', () => {
    expect(() => deletePortFile(path.join(TEST_DIR, 'nonexistent.json'))).not.toThrow();
  });

  it('returns null for invalid JSON', () => {
    fs.writeFileSync(portFilePath, 'not json', 'utf-8');
    const result = readPortFile(portFilePath);
    expect(result).toBeNull();
  });

  it('returns null for payload missing required fields', () => {
    fs.writeFileSync(portFilePath, JSON.stringify({ version: 1 }), 'utf-8');
    const result = readPortFile(portFilePath);
    expect(result).toBeNull();
  });
});

describe('BridgeDiscovery — stale PID', () => {
  const portFilePath = path.join(TEST_DIR, 'bridge-stale.json');

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { fs.unlinkSync(portFilePath); } catch { /* ignore */ }
    try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('returns false for current process PID (alive)', () => {
    const payload = makePayload();
    writePortFile(payload, portFilePath);

    expect(isStalePid(portFilePath)).toBe(false);
  });

  it('returns true for a dead PID', () => {
    const payload = makePayload({ pid: 999999999 }); // Non-existent PID
    writePortFile(payload, portFilePath);

    expect(isStalePid(portFilePath)).toBe(true);
  });

  it('returns false when no port file exists', () => {
    expect(isStalePid(path.join(TEST_DIR, 'nonexistent.json'))).toBe(false);
  });
});

describe('BridgeDiscovery — lifecycle', () => {
  const portFilePath = path.join(TEST_DIR, 'bridge-lifecycle.json');

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { fs.unlinkSync(portFilePath); } catch { /* ignore */ }
    try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it('starts discovery and writes port file', () => {
    const discovery = new BridgeDiscovery(portFilePath);
    const payload = makePayload();

    discovery.start(payload, false); // mDNS disabled for tests
    expect(fs.existsSync(portFilePath)).toBe(true);

    discovery.stop();
    expect(fs.existsSync(portFilePath)).toBe(false);
  });

  it('stop deletes the port file', () => {
    const discovery = new BridgeDiscovery(portFilePath);
    const payload = makePayload();

    discovery.start(payload, false);
    expect(fs.existsSync(portFilePath)).toBe(true);

    discovery.stop();
    expect(fs.existsSync(portFilePath)).toBe(false);
  });

  it('returns the port file path', () => {
    const discovery = new BridgeDiscovery(portFilePath);
    expect(discovery.getPortFilePath()).toBe(portFilePath);
  });

  it('double stop does not throw', () => {
    const discovery = new BridgeDiscovery(portFilePath);
    discovery.start(makePayload(), false);
    discovery.stop();
    expect(() => discovery.stop()).not.toThrow();
  });
});
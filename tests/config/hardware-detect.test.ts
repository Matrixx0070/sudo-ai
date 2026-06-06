/**
 * @file tests/config/hardware-detect.test.ts
 * @description Tests for hardware-detect.ts — CPU/RAM/GPU/wasmtime probing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Module mock setup
// ---------------------------------------------------------------------------

vi.mock('node:os');
vi.mock('node:child_process');

const mockedOs = vi.mocked(os);
const mockedSpawnSync = vi.mocked(spawnSync);

// Default mock: 4 cores, 8 GB RAM
function setupDefaultMocks(): void {
  mockedOs.cpus.mockReturnValue([
    { model: 'Intel Core i7-9750H', speed: 2600, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { model: 'Intel Core i7-9750H', speed: 2600, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { model: 'Intel Core i7-9750H', speed: 2600, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { model: 'Intel Core i7-9750H', speed: 2600, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
  ]);
  mockedOs.totalmem.mockReturnValue(8 * 1024 * 1024 * 1024); // 8 GB

  // spawnSync mock: wasmtime found, nvidia-smi not found
  mockedSpawnSync.mockImplementation((cmd: unknown, _args?: unknown) => {
    const cmdStr = String(cmd);
    if (cmdStr === 'wasmtime') {
      return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
    }
    // nvidia-smi not found
    return { status: 1, stdout: '', stderr: 'not found', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectHardware', () => {
  it('returns correct cpuCores and ramMb on standard system', async () => {
    setupDefaultMocks();
    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();

    expect(profile.cpuCores).toBe(4);
    expect(profile.cpuModel).toBe('Intel Core i7-9750H');
    expect(profile.ramMb).toBe(8192);
  });

  it('sets meetsMinimum true when cpuCores >= 2 and ramMb >= 2048', async () => {
    setupDefaultMocks();
    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();
    expect(profile.meetsMinimum).toBe(true);
  });

  it('sets meetsMinimum false and adds warning when ramMb < 2048', async () => {
    mockedOs.cpus.mockReturnValue([
      { model: 'ARM Cortex-A53', speed: 1200, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      { model: 'ARM Cortex-A53', speed: 1200, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
    mockedOs.totalmem.mockReturnValue(512 * 1024 * 1024); // 512 MB
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>);

    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();

    expect(profile.meetsMinimum).toBe(false);
    expect(profile.ramMb).toBe(512);
    expect(profile.warnings.some(w => w.includes('RAM'))).toBe(true);
  });

  it('sets meetsMinimum false and adds warning when cpuCores < 2', async () => {
    mockedOs.cpus.mockReturnValue([
      { model: 'Single Core CPU', speed: 800, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
    mockedOs.totalmem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>);

    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();

    expect(profile.meetsMinimum).toBe(false);
    expect(profile.cpuCores).toBe(1);
    expect(profile.warnings.some(w => w.includes('CPU'))).toBe(true);
  });

  it('detects wasmtime as available when spawnSync returns status 0', async () => {
    setupDefaultMocks();
    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();
    expect(profile.wasmtimeAvailable).toBe(true);
  });

  it('detects wasmtime as unavailable when spawnSync fails', async () => {
    mockedOs.cpus.mockReturnValue([
      { model: 'Intel', speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      { model: 'Intel', speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
    mockedOs.totalmem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>);

    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();
    expect(profile.wasmtimeAvailable).toBe(false);
    expect(profile.warnings.some(w => w.includes('wasmtime'))).toBe(true);
  });

  it('detects GPU from nvidia-smi output', async () => {
    mockedOs.cpus.mockReturnValue([
      { model: 'Intel i9', speed: 3600, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      { model: 'Intel i9', speed: 3600, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
    mockedOs.totalmem.mockReturnValue(16 * 1024 * 1024 * 1024);
    mockedSpawnSync.mockImplementation((cmd: unknown, _args?: unknown) => {
      const cmdStr = String(cmd);
      if (cmdStr === 'nvidia-smi') {
        return { status: 0, stdout: 'NVIDIA GeForce RTX 3090, 24576\n', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
      }
      return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
    });

    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();

    expect(profile.hasGpu).toBe(true);
    expect(profile.gpuModel).toContain('RTX 3090');
    expect(profile.gpuVramMb).toBe(24576);
  });

  it('hasGpu is false when nvidia-smi returns non-zero', async () => {
    setupDefaultMocks();
    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();
    expect(profile.hasGpu).toBe(false);
  });

  it('returns recommendedRuntime as cloud when no GPU', async () => {
    setupDefaultMocks();
    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();
    expect(profile.recommendedRuntime).toBe('cloud');
  });

  it('returns recommendedRuntime as ollama when GPU present and RAM >= 8 GB', async () => {
    mockedOs.cpus.mockReturnValue([
      { model: 'AMD EPYC', speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
      { model: 'AMD EPYC', speed: 3000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
    mockedOs.totalmem.mockReturnValue(32 * 1024 * 1024 * 1024); // 32 GB
    mockedSpawnSync.mockImplementation((cmd: unknown) => {
      if (String(cmd) === 'nvidia-smi') {
        return { status: 0, stdout: 'Tesla T4, 16384\n', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
      }
      return { status: 0, stdout: 'wasmtime 19.0.0', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>;
    });

    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    const profile = await detectHardware();
    expect(profile.recommendedRuntime).toBe('ollama');
  });

  it('never throws — handles os.cpus() failure gracefully', async () => {
    mockedOs.cpus.mockImplementation(() => { throw new Error('cpus failed'); });
    mockedOs.totalmem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '', error: undefined, pid: 1, signal: null, output: [] } as ReturnType<typeof spawnSync>);

    const { detectHardware } = await import('../../src/core/config/hardware-detect.js');
    await expect(detectHardware()).resolves.toBeDefined();
  });
});

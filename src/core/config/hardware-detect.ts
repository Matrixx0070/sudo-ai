/**
 * @file config/hardware-detect.ts
 * @description Probes CPU, RAM, and optional GPU for hardware capability detection.
 *
 * Uses only Node built-ins (os, child_process) — zero new dependencies.
 * GPU detection: optional nvidia-smi subprocess (fails gracefully if absent).
 * WASM runtime: checks wasmtime --version in PATH (fails gracefully if absent).
 *
 * Minimum requirements:
 *   cpuCores >= 2 AND ramMb >= 2048 (2 GB)
 *
 * @module hardware-detect
 */

import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { HardwareProfile, EngineRuntime } from '../shared/wave10-types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hardware-detect');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_CPU_CORES = 2;
const MIN_RAM_MB = 2048;

// ---------------------------------------------------------------------------
// GPU detection via nvidia-smi
// ---------------------------------------------------------------------------

interface GpuInfo {
  model: string;
  vramMb: number;
}

function probeNvidiaGpu(): GpuInfo | null {
  try {
    const result = spawnSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 3000 },
    );

    if (result.status !== 0 || result.error || !result.stdout) {
      return null;
    }

    const line = result.stdout.trim().split('\n')[0] ?? '';
    const parts = line.split(',');
    if (parts.length < 2) return null;

    const model = (parts[0] ?? '').trim();
    const vramMb = parseInt((parts[1] ?? '0').trim(), 10);

    if (!model || !Number.isFinite(vramMb)) return null;
    return { model, vramMb };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// wasmtime availability check
// ---------------------------------------------------------------------------

function checkWasmtime(): boolean {
  try {
    const result = spawnSync('wasmtime', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Runtime recommendation
// ---------------------------------------------------------------------------

function recommendRuntime(hasGpu: boolean, ramMb: number): EngineRuntime {
  // If GPU detected with sufficient VRAM, prefer local ollama
  if (hasGpu && ramMb >= 8192) return 'ollama';
  // If decent RAM but no GPU, suggest cloud provider
  if (ramMb >= 4096) return 'cloud';
  // Minimal resources: still use cloud but note constraint
  return 'cloud';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Probes the host hardware and returns a {@link HardwareProfile}.
 *
 * Never throws — all probe failures are caught and reflected in warnings or
 * absent optional fields. Safe to call at boot step 0.5 without crashing.
 *
 * @returns Resolved HardwareProfile with warnings for sub-optimal configs.
 */
export async function detectHardware(): Promise<HardwareProfile> {
  const warnings: string[] = [];

  // CPU
  let cpuModel = 'unknown';
  let cpuCores = 1;
  try {
    const cpus = os.cpus();
    cpuCores = cpus.length;
    cpuModel = cpus[0]?.model?.trim() ?? 'unknown';
  } catch (err) {
    warnings.push(`CPU probe failed: ${String(err)}`);
  }

  // RAM
  let ramMb = 0;
  try {
    ramMb = Math.floor(os.totalmem() / (1024 * 1024));
  } catch (err) {
    warnings.push(`RAM probe failed: ${String(err)}`);
  }

  // GPU (optional — nvidia-smi)
  let hasGpu = false;
  let gpuModel: string | undefined;
  let gpuVramMb: number | undefined;
  try {
    const gpu = probeNvidiaGpu();
    if (gpu) {
      hasGpu = true;
      gpuModel = gpu.model;
      gpuVramMb = gpu.vramMb;
    }
  } catch (err) {
    // Non-fatal — GPU is optional
    log.debug({ err: String(err) }, 'GPU probe failed (non-fatal)');
  }

  // wasmtime
  let wasmtimeAvailable = false;
  try {
    wasmtimeAvailable = checkWasmtime();
  } catch {
    // Non-fatal
  }

  // Minimum requirement check
  const meetsMinimum = cpuCores >= MIN_CPU_CORES && ramMb >= MIN_RAM_MB;

  if (cpuCores < MIN_CPU_CORES) {
    warnings.push(
      `CPU cores ${cpuCores} is below minimum ${MIN_CPU_CORES}. Performance may be degraded.`,
    );
  }

  if (ramMb < MIN_RAM_MB) {
    warnings.push(
      `RAM ${ramMb} MB is below minimum ${MIN_RAM_MB} MB. Consider upgrading or using a cloud runtime.`,
    );
  }

  if (!wasmtimeAvailable) {
    warnings.push(
      'wasmtime not found in PATH. WASM sandbox will be unavailable. Install wasmtime to enable.',
    );
  }

  const recommendedRuntime = recommendRuntime(hasGpu, ramMb);

  const profile: HardwareProfile = {
    cpuModel,
    cpuCores,
    ramMb,
    hasGpu,
    ...(gpuModel !== undefined ? { gpuModel } : {}),
    ...(gpuVramMb !== undefined ? { gpuVramMb } : {}),
    meetsMinimum,
    warnings,
    recommendedRuntime,
    wasmtimeAvailable,
  };

  log.info(
    {
      cpuCores,
      ramMb,
      hasGpu,
      wasmtimeAvailable,
      meetsMinimum,
      recommendedRuntime,
    },
    'Hardware profile detected',
  );

  return profile;
}

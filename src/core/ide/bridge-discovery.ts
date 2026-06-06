/**
 * @file bridge-discovery.ts
 * @description IDE discovery mechanism for the IDE Bridge.
 *
 * Writes a port file at `~/.sudo-ai/bridge.json` and optionally advertises
 * via mDNS (`_sudo-ai._tcp`). IDE extensions read the port file to discover
 * the running SUDO-AI instance.
 *
 * @module ide-bridge-discovery
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../shared/logger.js';
import type { BridgeDiscoveryPayload } from '../../../shared-types/bridge-protocol.js';

const log = createLogger('ide:bridge-discovery');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory for discovery files. */
const DEFAULT_SUDO_DIR = path.join(os.homedir(), '.sudo-ai');

/** Default port file name. */
const DEFAULT_PORT_FILE = 'bridge.json';

// ---------------------------------------------------------------------------
// Port File Management
// ---------------------------------------------------------------------------

/**
 * Write the discovery port file.
 *
 * Creates `~/.sudo-ai/bridge.json` with the discovery payload so IDE extensions
 * can find the running SUDO-AI instance.
 *
 * @param payload - The discovery payload to write.
 * @param portFilePath - Override path for the port file. Defaults to `~/.sudo-ai/bridge.json`.
 */
export function writePortFile(
  payload: BridgeDiscoveryPayload,
  portFilePath?: string,
): string {
  const filePath = portFilePath ?? path.join(DEFAULT_SUDO_DIR, DEFAULT_PORT_FILE);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Write atomically via temp file + rename
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);

  log.info({ path: filePath, port: payload.port }, 'Bridge discovery port file written');
  return filePath;
}

/**
 * Read the discovery port file.
 *
 * @param portFilePath - Override path for the port file.
 * @returns The discovery payload, or null if the file doesn't exist or is invalid.
 */
export function readPortFile(portFilePath?: string): BridgeDiscoveryPayload | null {
  const filePath = portFilePath ?? path.join(DEFAULT_SUDO_DIR, DEFAULT_PORT_FILE);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const payload = JSON.parse(content) as BridgeDiscoveryPayload;

    // Basic validation
    if (!payload.version || !payload.url || !payload.wsUrl || !payload.port) {
      log.warn({ path: filePath }, 'Bridge port file missing required fields');
      return null;
    }

    return payload;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: String(err), path: filePath }, 'Failed to read bridge port file');
    }
    return null;
  }
}

/**
 * Delete the discovery port file.
 *
 * @param portFilePath - Override path for the port file.
 */
export function deletePortFile(portFilePath?: string): void {
  const filePath = portFilePath ?? path.join(DEFAULT_SUDO_DIR, DEFAULT_PORT_FILE);

  try {
    fs.unlinkSync(filePath);
    log.info({ path: filePath }, 'Bridge discovery port file deleted');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: String(err), path: filePath }, 'Failed to delete bridge port file');
    }
  }
}

/**
 * Check if the PID recorded in the port file is still running.
 * Used by IDE extensions to detect stale port files from crashed instances.
 *
 * @param portFilePath - Override path for the port file.
 * @returns True if the PID is still running (or no file exists), false if stale.
 */
export function isStalePid(portFilePath?: string): boolean {
  const payload = readPortFile(portFilePath);
  if (!payload) return false; // no file → not stale

  try {
    // Signal 0 checks if the process exists without sending a signal
    process.kill(payload.pid, 0);
    return false; // process is alive
  } catch {
    return true; // process is dead → stale
  }
}

// ---------------------------------------------------------------------------
// mDNS Advertisement (best-effort)
// ---------------------------------------------------------------------------

let mdnsBrowser: unknown = null;
let mdnsService: unknown = null;

/**
 * Start mDNS advertisement for `_sudo-ai._tcp`.
 *
 * This is best-effort: if the `bonjour-service` package is not available,
 * mDNS is silently skipped.
 *
 * @param port - The port the gateway is listening on.
 * @param options - Optional: custom mDNS settings.
 */
export function startMdns(port: number, options?: { name?: string }): void {
  try {
    // Dynamic import — bonjour-service may not be installed
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bonjour = require('bonjour-service');
    mdnsBrowser = new bonjour.default();

    mdnsService = (mdnsBrowser as any).publish({
      name: options?.name ?? 'sudo-ai',
      type: 'sudo-ai',
      port,
      txt: { version: '1' },
    });

    log.info({ port }, 'mDNS advertisement started for _sudo-ai._tcp');
  } catch (err) {
    log.debug({ err: String(err) }, 'mDNS not available — skipping advertisement');
  }
}

/**
 * Stop mDNS advertisement.
 */
export function stopMdns(): void {
  try {
    if (mdnsService && typeof (mdnsService as any).stop === 'function') {
      (mdnsService as any).stop();
    }
    if (mdnsBrowser && typeof (mdnsBrowser as any).destroy === 'function') {
      (mdnsBrowser as any).destroy();
    }
  } catch (err) {
    log.debug({ err: String(err) }, 'Error stopping mDNS');
  } finally {
    mdnsService = null;
    mdnsBrowser = null;
  }
}

// ---------------------------------------------------------------------------
// Bridge Discovery Manager
// ---------------------------------------------------------------------------

/**
 * Manages the bridge discovery lifecycle: writing port file and advertising via mDNS.
 */
export class BridgeDiscovery {
  private portFilePath: string;
  private portFileWritten = false;
  private mdnsStarted = false;

  constructor(portFilePath?: string) {
    this.portFilePath = portFilePath ?? path.join(DEFAULT_SUDO_DIR, DEFAULT_PORT_FILE);
  }

  /**
   * Start discovery: write port file and optionally advertise via mDNS.
   *
   * @param payload - The discovery payload.
   * @param mdnsEnabled - Whether to start mDNS advertisement.
   */
  start(payload: BridgeDiscoveryPayload, mdnsEnabled = true): string {
    const filePath = writePortFile(payload, this.portFilePath);
    this.portFileWritten = true;

    if (mdnsEnabled) {
      startMdns(payload.port);
      this.mdnsStarted = true;
    }

    return filePath;
  }

  /**
   * Stop discovery: delete port file and stop mDNS.
   */
  stop(): void {
    if (this.portFileWritten) {
      deletePortFile(this.portFilePath);
      this.portFileWritten = false;
    }

    if (this.mdnsStarted) {
      stopMdns();
      this.mdnsStarted = false;
    }
  }

  /**
   * Get the port file path.
   */
  getPortFilePath(): string {
    return this.portFilePath;
  }
}
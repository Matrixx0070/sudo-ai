/**
 * @file security/component-scanner.ts
 * @description Scans for installed components across npm, pip, and MCP servers.
 *
 * Scanners:
 *  - scanNpm(): reads package.json dependencies + devDependencies
 *  - scanPip(): executes `pip list --format=json` (graceful fail if pip unavailable)
 *  - scanMCP(): reads ~/.hermes or SUDO_AI_HOME config for MCP server versions
 *
 * Env:
 *  - SUDO_AI_HOME — override config directory (default: ~/.hermes)
 */

import { createLogger } from '../shared/logger.js';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const log = createLogger('component-scanner');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComponentInfo {
  name: string;
  version: string;
  ecosystem: 'npm' | 'PyPI' | 'MCP';
  source: string;
  direct: boolean;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PipPackage {
  name: string;
  version: string;
}

// ---------------------------------------------------------------------------
// NPM Scanner
// ---------------------------------------------------------------------------

function findPackageJson(): string | null {
  // Only check current directory for package.json
  // This prevents scanning parent projects during tests
  const localPath = path.resolve('package.json');
  if (existsSync(localPath)) return localPath;
  return null;
}

export function scanNpm(): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  const pkgPath = findPackageJson();

  if (!pkgPath) {
    log.warn('package.json not found in common locations');
    return components;
  }

  try {
    const content = readFileSync(pkgPath, 'utf-8');
    const pkg: PackageJson = JSON.parse(content);

    // Direct dependencies
    if (pkg.dependencies) {
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        // Strip version prefixes for cleaner matching
        const cleanVersion = version.replace(/^[\^~>=<]+/, '');
        components.push({
          name,
          version: cleanVersion,
          ecosystem: 'npm',
          source: pkgPath,
          direct: true,
        });
      }
    }

    // Dev dependencies
    if (pkg.devDependencies) {
      for (const [name, version] of Object.entries(pkg.devDependencies)) {
        const cleanVersion = version.replace(/^[\^~>=<]+/, '');
        components.push({
          name,
          version: cleanVersion,
          ecosystem: 'npm',
          source: pkgPath,
          direct: true,
        });
      }
    }

    log.info({ count: components.length, source: pkgPath }, 'Scanned npm packages');
  } catch (err) {
    log.error({ err: String(err), path: pkgPath }, 'Failed to parse package.json');
  }

  return components;
}

// ---------------------------------------------------------------------------
// Pip Scanner
// ---------------------------------------------------------------------------

export function scanPip(): ComponentInfo[] {
  const components: ComponentInfo[] = [];

  try {
    const output = execSync('pip list --format=json 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 30_000,
    });

    const packages: PipPackage[] = JSON.parse(output);
    for (const pkg of packages) {
      components.push({
        name: pkg.name,
        version: pkg.version,
        ecosystem: 'PyPI',
        source: 'pip',
        direct: false, // Cannot distinguish direct vs transitive without pipfile
      });
    }

    log.info({ count: components.length }, 'Scanned pip packages');
  } catch (err) {
    // Graceful fail - pip may not be installed
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ENOENT') && !msg.includes('pip')) {
      log.warn({ err: msg }, 'pip scan failed (pip may not be installed)');
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// MCP Scanner
// ---------------------------------------------------------------------------

function getMcpConfigPath(): string | null {
  const sudoHome = process.env['SUDO_AI_HOME'];
  if (sudoHome) {
    return path.join(sudoHome, 'mcp-config.json');
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.hermes', 'mcp-config.json'),
    path.join(home, '.config', 'hermes', 'mcp-config.json'),
    path.join(home, 'sudo-ai', 'mcp-config.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function scanMcp(): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  const configPath = getMcpConfigPath();

  if (!configPath) {
    log.debug('MCP config not found (checked ~/.hermes and SUDO_AI_HOME)');
    return components;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config: unknown = JSON.parse(content);

    if (config && typeof config === 'object' && 'servers' in config) {
      const servers = config.servers as Record<string, unknown> | undefined;
      if (servers) {
        for (const [name, server] of Object.entries(servers)) {
          if (server && typeof server === 'object' && 'version' in server) {
            const version = String(server.version);
            components.push({
              name,
              version,
              ecosystem: 'MCP',
              source: configPath,
              direct: true,
            });
          }
        }
      }
    }

    log.info({ count: components.length, source: configPath }, 'Scanned MCP servers');
  } catch (err) {
    log.error({ err: String(err), path: configPath }, 'Failed to parse MCP config');
  }

  return components;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Scan all supported ecosystems for installed components.
 * Returns a unified list of ComponentInfo objects.
 */
export function scanAll(): ComponentInfo[] {
  log.info('Starting component scan across all ecosystems');

  const npm = scanNpm();
  const pip = scanPip();
  const mcp = scanMcp();

  const total = npm.length + pip.length + mcp.length;
  log.info({ total, npm: npm.length, pip: pip.length, mcp: mcp.length }, 'Component scan complete');

  return [...npm, ...pip, ...mcp];
}

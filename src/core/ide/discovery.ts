/**
 * @file ide/discovery.ts
 * @description IDE auto-detection and Language Server Protocol (LSP) discovery.
 *
 * Scans the host system for running IDEs, installed extensions, and
 * available language server binaries. Follows the hardware-detect pattern
 * of graceful fallback (never throws).
 *
 * Competitive context: Claude Code auto-detects VS Code and JetBrains IDEs,
 * installs extensions, and recommends LSP servers. This module provides
 * SUDO-AI's equivalent detection and discovery capabilities.
 *
 * @module ide-discovery
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type {
  DetectedIDE,
  IDECategory,
  IDEId,
  IDEScanResult,
  DiscoveredLSP,
  LSPServerRegistry,
  IDEManagerConfig,
} from './types.js';
import { KNOWN_LSP_SERVERS, DEFAULT_IDE_MANAGER_CONFIG } from './types.js';

const log = createLogger('ide:discovery');

// ---------------------------------------------------------------------------
// IDE Binary & Config Definitions
// ---------------------------------------------------------------------------

interface IDEProfile {
  id: IDEId;
  name: string;
  category: IDECategory;
  /** Possible binary names to search for. */
  binaries: string[];
  /** Possible process names to look for. */
  processNames: string[];
  /** Possible config directory names (under XDG_CONFIG_HOME or equivalent). */
  configDirNames: string[];
  /** Environment variable that, if set, indicates this IDE is running. */
  envVars: string[];
  /** Arguments to get the version. */
  versionArgs: string[];
  /** macOS app bundle identifier (for future macOS support). */
  macBundleId?: string;
}

/** Profiles for all detectable IDEs. */
const IDE_PROFILES: IDEProfile[] = [
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    category: 'vscode-family',
    binaries: ['code'],
    processNames: ['code', 'vscode', 'visual studio code'],
    configDirNames: ['Code', 'VSCode'],
    envVars: ['VSCODE_IPC_HOOK', 'ELECTRON_RUN_AS_NODE'],
    versionArgs: ['--version'],
  },
  {
    id: 'vscode-insiders',
    name: 'Visual Studio Code - Insiders',
    category: 'vscode-family',
    binaries: ['code-insiders'],
    processNames: ['code-insiders'],
    configDirNames: ['Code - Insiders'],
    envVars: ['VSCODE_IPC_HOOK_INSIDERS'],
    versionArgs: ['--version'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    category: 'vscode-family',
    binaries: ['cursor'],
    processNames: ['cursor'],
    configDirNames: ['Cursor'],
    envVars: ['CURSOR_TRACE_ID'],
    versionArgs: ['--version'],
  },
  {
    id: 'jetbrains-intellij',
    name: 'IntelliJ IDEA',
    category: 'jetbrains-family',
    binaries: ['idea', 'idea64', 'idea.sh'],
    processNames: ['idea', 'idea64', 'intellij'],
    configDirNames: ['IntelliJIdea', 'IdeaIC'],
    envVars: ['IDEA_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'jetbrains-webstorm',
    name: 'WebStorm',
    category: 'jetbrains-family',
    binaries: ['webstorm', 'webstorm64', 'webstorm.sh'],
    processNames: ['webstorm', 'webstorm64'],
    configDirNames: ['WebStorm'],
    envVars: ['WEBSTORM_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'jetbrains-pycharm',
    name: 'PyCharm',
    category: 'jetbrains-family',
    binaries: ['pycharm', 'pycharm64', 'pycharm.sh'],
    processNames: ['pycharm', 'pycharm64'],
    configDirNames: ['PyCharm'],
    envVars: ['PYCHARM_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'jetbrains-goland',
    name: 'GoLand',
    category: 'jetbrains-family',
    binaries: ['goland', 'goland64', 'goland.sh'],
    processNames: ['goland', 'goland64'],
    configDirNames: ['GoLand'],
    envVars: ['GOLAND_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'jetbrains-clion',
    name: 'CLion',
    category: 'jetbrains-family',
    binaries: ['clion', 'clion64', 'clion.sh'],
    processNames: ['clion', 'clion64'],
    configDirNames: ['CLion'],
    envVars: ['CLION_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'jetbrains-rider',
    name: 'Rider',
    category: 'jetbrains-family',
    binaries: ['rider', 'rider64', 'rider.sh'],
    processNames: ['rider', 'rider64'],
    configDirNames: ['Rider'],
    envVars: ['RIDER_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'jetbrains-rubymine',
    name: 'RubyMine',
    category: 'jetbrains-family',
    binaries: ['rubymine', 'rubymine64', 'rubymine.sh'],
    processNames: ['rubymine', 'rubymine64'],
    configDirNames: ['RubyMine'],
    envVars: ['RUBYMINE_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'jetbrains-phpstorm',
    name: 'PhpStorm',
    category: 'jetbrains-family',
    binaries: ['phpstorm', 'phpstorm64', 'phpstorm.sh'],
    processNames: ['phpstorm', 'phpstorm64'],
    configDirNames: ['PhpStorm'],
    envVars: ['PHPSTORM_PROPERTIES'],
    versionArgs: [],
  },
  {
    id: 'neovim',
    name: 'Neovim',
    category: 'vim-family',
    binaries: ['nvim'],
    processNames: ['nvim', 'neovim'],
    configDirNames: ['nvim'],
    envVars: ['NVIM', 'NVIM_LISTEN_ADDRESS'],
    versionArgs: ['--version'],
  },
  {
    id: 'vim',
    name: 'Vim',
    category: 'vim-family',
    binaries: ['vim', 'vi'],
    processNames: ['vim', 'vi'],
    configDirNames: ['vim'],
    envVars: [],
    versionArgs: ['--version'],
  },
  {
    id: 'emacs',
    name: 'Emacs',
    category: 'vim-family',
    binaries: ['emacs', 'emacsclient'],
    processNames: ['emacs'],
    configDirNames: ['.emacs.d', '.config/emacs'],
    envVars: ['EMACS', 'EMACSLOADPATH'],
    versionArgs: ['--version'],
  },
];

// ---------------------------------------------------------------------------
// Process Detection Helpers
// ---------------------------------------------------------------------------

/** Get list of currently running process names (lowercased). */
function getRunningProcessNames(): Set<string> {
  try {
    const result = spawnSync('ps', ['aux'], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0 || !result.stdout) return new Set();

    const names = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      // ps aux format: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 11) {
        // Take just the command name (last field, potentially with path)
        const cmd = parts[parts.length - 1] ?? '';
        const basename = path.basename(cmd).toLowerCase();
        if (basename) names.add(basename);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

/** Check if a binary exists in PATH. */
function findBinary(binary: string): string | null {
  try {
    const result = spawnSync('which', [binary], { encoding: 'utf8', timeout: 3000 });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    // Fallback: try command -v
    const result2 = spawnSync('command', ['-v', binary], { encoding: 'utf8', timeout: 3000, shell: true });
    if (result2.status === 0 && result2.stdout) {
      return result2.stdout.trim();
    }
  } catch {
    // Not found
  }
  return null;
}

/** Get version string from a binary. */
function getBinaryVersion(binaryPath: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(binaryPath, args, { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      // Take the first line, strip common prefixes
      const firstLine = result.stdout.trim().split('\n')[0] ?? '';
      return firstLine.trim();
    }
  } catch {
    // Version detection failed
  }
  return undefined;
}

/** Get the platform-specific config directory for an IDE. */
function getConfigDir(configDirName: string): string | undefined {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'linux') {
    // XDG_CONFIG_HOME or default ~/.config
    const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
    const configPath = path.join(xdgConfig, configDirName);
    try {
      if (fs.existsSync(configPath)) return configPath;
    } catch {
      // Not accessible
    }
    // Also check for JetBrains under ~/.local/share/JetBrains
    const jetbrainsPath = path.join(home, '.local', 'share', 'JetBrains', configDirName);
    try {
      if (fs.existsSync(jetbrainsPath)) return jetbrainsPath;
    } catch {
      // Not accessible
    }
  } else if (platform === 'darwin') {
    const configPath = path.join(home, 'Library', 'Application Support', configDirName);
    try {
      if (fs.existsSync(configPath)) return configPath;
    } catch {
      // Not accessible
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// IDE Detection
// ---------------------------------------------------------------------------

/**
 * Scan the host system for installed and running IDEs.
 *
 * Never throws — all detection failures are silently skipped.
 * Uses process scanning, PATH lookup, and config directory detection.
 */
export function detectIDEs(config?: Partial<IDEManagerConfig>): IDEScanResult {
  const startTime = Date.now();
  const mergedConfig: IDEManagerConfig = {
    ...DEFAULT_IDE_MANAGER_CONFIG,
    ...config,
    install: { ...DEFAULT_IDE_MANAGER_CONFIG.install, ...config?.install },
  };

  log.debug('Starting IDE detection scan');

  const runningProcesses = getRunningProcessNames();
  const detected: DetectedIDE[] = [];

  for (const profile of IDE_PROFILES) {
    let isRunning = false;
    let binaryPath: string | undefined;
    let version: string | undefined;
    let configDir: string | undefined;
    let detectionMethod: DetectedIDE['detectionMethod'] = 'manual';

    // 1. Check environment variables (strongest signal for running IDE)
    for (const envVar of profile.envVars) {
      if (process.env[envVar]) {
        isRunning = true;
        detectionMethod = 'env';
        break;
      }
    }

    // 2. Check running processes
    if (!isRunning) {
      for (const procName of profile.processNames) {
        if (runningProcesses.has(procName.toLowerCase())) {
          isRunning = true;
          detectionMethod = 'process';
          break;
        }
      }
    }

    // 3. Find binary in PATH
    for (const binary of profile.binaries) {
      const found = findBinary(binary);
      if (found) {
        binaryPath = found;
        if (detectionMethod === 'manual') detectionMethod = 'path';
        // Try to get version
        if (profile.versionArgs.length > 0) {
          version = getBinaryVersion(found, profile.versionArgs);
        }
        break;
      }
    }

    // 4. Check config directories
    for (const configDirName of profile.configDirNames) {
      const found = getConfigDir(configDirName);
      if (found) {
        configDir = found;
        if (detectionMethod === 'manual') detectionMethod = 'config_file';
        break;
      }
    }

    // Only include IDEs that were detected (binary, config, or running)
    if (binaryPath || configDir || isRunning) {
      detected.push({
        id: profile.id,
        name: profile.name,
        category: profile.category,
        isRunning,
        binaryPath,
        version,
        configDir,
        detectionMethod,
      });

      log.debug(
        { id: profile.id, isRunning, hasBinary: !!binaryPath, detectionMethod },
        'IDE detected',
      );
    }
  }

  const result: IDEScanResult = {
    ides: detected,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - startTime,
    platform: os.platform() as IDEScanResult['platform'],
  };

  log.info(
    { count: detected.length, durationMs: result.scanDurationMs },
    'IDE detection scan complete',
  );

  return result;
}

// ---------------------------------------------------------------------------
// LSP Discovery
// ---------------------------------------------------------------------------

/**
 * Discover language servers available on the host system.
 *
 * Scans PATH, npm global packages, VS Code extensions, and JetBrains plugins
 * for known language server binaries. Never throws.
 */
export function discoverLanguageServers(
  config?: Partial<IDEManagerConfig>,
): DiscoveredLSP[] {
  const mergedConfig: IDEManagerConfig = {
    ...DEFAULT_IDE_MANAGER_CONFIG,
    ...config,
    install: { ...DEFAULT_IDE_MANAGER_CONFIG.install, ...config?.install },
  };

  const discovered: DiscoveredLSP[] = [];

  for (const serverDef of KNOWN_LSP_SERVERS) {
    try {
    let binaryPath: string | undefined;
    let version: string | undefined;
    let discoveryMethod: DiscoveredLSP['discoveryMethod'] = 'manual';

    // 1. Search PATH for binary
    for (const binary of serverDef.binaries) {
      const found = findBinary(binary);
      if (found) {
        binaryPath = found;
        discoveryMethod = 'path';
        // Try to get version
        try {
          const versionResult = spawnSync(found, ['--version'], {
            encoding: 'utf8',
            timeout: 3000,
          });
          if (versionResult.status === 0 && versionResult.stdout) {
            version = versionResult.stdout.trim().split('\n')[0] ?? undefined;
          }
        } catch {
          // Version detection is non-fatal
        }
        break;
      }
    }

    // 2. Search npm global packages
    if (!binaryPath && serverDef.npmPackages.length > 0) {
      const npmGlobalResult = spawnSync('npm', ['list', '-g', '--depth=0', '--json'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (npmGlobalResult.status === 0 && npmGlobalResult.stdout) {
        try {
          const npmList = JSON.parse(npmGlobalResult.stdout);
          const deps = npmList?.dependencies ?? {};
          for (const pkg of serverDef.npmPackages) {
            if (deps[pkg]) {
              // Package is installed globally — find its binary
              const npmBinResult = spawnSync('npm', ['bin', '-g'], {
                encoding: 'utf8',
                timeout: 3000,
              });
              if (npmBinResult.status === 0 && npmBinResult.stdout) {
                const npmBinDir = npmBinResult.stdout.trim();
                // Try to find the binary in npm's global bin directory
                for (const binary of serverDef.binaries) {
                  const potentialPath = path.join(npmBinDir, binary);
                  try {
                    if (fs.existsSync(potentialPath)) {
                      binaryPath = potentialPath;
                      discoveryMethod = 'npm_global';
                      break;
                    }
                  } catch {
                    // Not accessible
                  }
                }
              }
              break;
            }
          }
        } catch {
          // npm list parse failed — skip
        }
      }
    }

    // 3. Search additional paths from config
    if (!binaryPath && mergedConfig.additionalLSPPaths.length > 0) {
      for (const searchPath of mergedConfig.additionalLSPPaths) {
        for (const binary of serverDef.binaries) {
          const potentialPath = path.join(searchPath, binary);
          try {
            if (fs.existsSync(potentialPath)) {
              binaryPath = potentialPath;
              discoveryMethod = 'config';
              break;
            }
          } catch {
            // Not accessible
          }
        }
        if (binaryPath) break;
      }
    }

    // 4. Check VS Code extensions (if VS Code is detected)
    if (!binaryPath && serverDef.vscodeExtensions.length > 0) {
      const vscodeExtsDir = getVSCodeExtensionsDir();
      if (vscodeExtsDir) {
        try {
          const entries = fs.readdirSync(vscodeExtsDir);
          for (const extId of serverDef.vscodeExtensions) {
            // VS Code extensions are stored as publisher.name-version
            const publisherName = extId;
            const found = entries.find((entry) => entry.startsWith(publisherName));
            if (found) {
              // Extension is installed — look for language server binary inside
              const extDir = path.join(vscodeExtsDir, found);
              binaryPath = findLSPBinaryInExtension(extDir, serverDef.binaries);
              if (binaryPath) {
                discoveryMethod = 'vscode_extension';
                break;
              }
            }
          }
        } catch {
          // Extensions directory not accessible
        }
      }
    }

    const serverId = `lsp-${serverDef.language}`;

    discovered.push({
      id: serverId,
      name: `${serverDef.language.charAt(0).toUpperCase() + serverDef.language.slice(1)} Language Server`,
      language: serverDef.language,
      command: binaryPath ?? serverDef.binaries[0] ?? serverDef.language,
      args: binaryPath ? serverDef.defaultArgs : [],
      binaryPath,
      version,
      discoveryMethod,
      fileExtensions: serverDef.fileExtensions,
      available: !!binaryPath,
    });
    } catch (err) {
      // Discovery for this server failed — add as unavailable
      log.debug({ language: serverDef.language, err: String(err) }, 'LSP discovery failed for server');
      discovered.push({
        id: `lsp-${serverDef.language}`,
        name: `${serverDef.language.charAt(0).toUpperCase() + serverDef.language.slice(1)} Language Server`,
        language: serverDef.language,
        command: serverDef.binaries[0] ?? serverDef.language,
        args: [],
        binaryPath: undefined,
        version: undefined,
        discoveryMethod: 'manual',
        fileExtensions: serverDef.fileExtensions,
        available: false,
      });
    }
  }

  log.info(
    {
      total: discovered.length,
      available: discovered.filter((s) => s.available).length,
    },
    'LSP discovery complete',
  );

  return discovered;
}

/**
 * Get the VS Code extensions directory.
 */
function getVSCodeExtensionsDir(): string | null {
  const home = os.homedir();
  const platform = os.platform();

  let extDir: string;
  if (platform === 'linux') {
    extDir = path.join(home, '.vscode', 'extensions');
  } else if (platform === 'darwin') {
    extDir = path.join(home, '.vscode', 'extensions');
  } else {
    extDir = path.join(home, '.vscode', 'extensions');
  }

  try {
    if (fs.existsSync(extDir)) return extDir;
  } catch {
    // Not accessible
  }
  return null;
}

/**
 * Search for an LSP binary inside a VS Code extension directory.
 */
function findLSPBinaryInExtension(
  extDir: string,
  binaryNames: string[],
): string | undefined {
  try {
    // Look for server binaries in common locations
    const searchDirs = ['server', 'node_modules/.bin', 'bin', 'dist'];
    for (const subDir of searchDirs) {
      const dir = path.join(extDir, subDir);
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir);
        for (const binary of binaryNames) {
          if (entries.includes(binary)) {
            return path.join(dir, binary);
          }
        }
      } catch {
        // Not accessible
      }
    }
  } catch {
    // Extension directory not accessible
  }
  return undefined;
}

/**
 * Get an LSP recommendation for a given file path.
 *
 * Matches the file extension to known language servers and returns
 * the best available server.
 */
export function getLSPRecommendation(
  filePath: string,
  discoveredServers: DiscoveredLSP[],
): DiscoveredLSP | null {
  const ext = path.extname(filePath).toLowerCase();

  // Find servers that support this file extension
  const matching = discoveredServers.filter((server) =>
    server.fileExtensions.includes(ext),
  );

  if (matching.length === 0) return null;

  // Prefer available servers, then by discovery method reliability
  const sorted = matching.sort((a, b) => {
    // Available servers come first
    if (a.available !== b.available) return a.available ? -1 : 1;
    // Then by discovery method reliability
    const methodOrder: Record<string, number> = {
      path: 0,
      npm_global: 1,
      vscode_extension: 2,
      config: 3,
      manual: 4,
    };
    return (methodOrder[a.discoveryMethod] ?? 99) - (methodOrder[b.discoveryMethod] ?? 99);
  });

  return sorted[0] ?? null;
}

/**
 * Check if a specific IDE has the SUDO-AI extension installed.
 */
export function isExtensionInstalled(
  ide: DetectedIDE,
  extensionId: string,
): boolean {
  if (!ide.configDir) return false;

  const platform = os.platform();
  let extensionsDir: string;

  if (ide.category === 'vscode-family') {
    // VS Code / Cursor extensions directory
    extensionsDir = path.join(os.homedir(), '.vscode', 'extensions');
  } else if (ide.category === 'jetbrains-family') {
    // JetBrains plugins directory
    extensionsDir = path.join(ide.configDir, 'plugins');
  } else {
    // Vim/Neovim — check for plugin managers
    const home = os.homedir();
    if (ide.id === 'neovim') {
      extensionsDir = path.join(home, '.local', 'share', 'nvim', 'site', 'pack');
    } else if (ide.id === 'vim') {
      extensionsDir = path.join(home, '.vim', 'pack');
    } else if (ide.id === 'emacs') {
      extensionsDir = path.join(home, '.emacs.d', 'elpa');
    } else {
      return false;
    }
  }

  try {
    if (!fs.existsSync(extensionsDir)) return false;
    const entries = fs.readdirSync(extensionsDir);
    // Check if any entry starts with the extension publisher.id
    return entries.some((entry) =>
      entry.toLowerCase().includes(extensionId.toLowerCase()),
    );
  } catch {
    return false;
  }
}
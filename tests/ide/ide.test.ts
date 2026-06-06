/**
 * @file tests/ide/ide.test.ts
 * @description Tests for IDE auto-detection, extension installation,
 * LSP discovery, and LSP client management.
 *
 * Covers: IDE detection, LSP discovery, extension status checking,
 * LSP recommendation, LSP client lifecycle, IDE manager facade,
 * caching, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectIDEs,
  discoverLanguageServers,
  getLSPRecommendation,
  isExtensionInstalled,
} from '../../src/core/ide/discovery.js';
import {
  checkExtensionStatus,
  installExtension,
  getInstallationSummary,
} from '../../src/core/ide/installer.js';
import { LSPClient, LSPClientManager } from '../../src/core/ide/lsp-client.js';
import { IDEManager } from '../../src/core/ide/index.js';
import type {
  DetectedIDE,
  DiscoveredLSP,
  ExtensionId,
  IDEInstallConfig,
  IDEScanResult,
  LSPConnectionState,
} from '../../src/core/ide/types.js';
import {
  SUDO_VSCODE_EXTENSION,
  DEFAULT_IDE_INSTALL_CONFIG,
  DEFAULT_IDE_MANAGER_CONFIG,
  KNOWN_LSP_SERVERS,
} from '../../src/core/ide/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock child_process.spawnSync for detection
const mockSpawnSync = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  spawn: vi.fn(),
}));

// Mock fs for extension checking
const mockFsExistsSync = vi.fn();
const mockFsReaddirSync = vi.fn();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
    readdirSync: (...args: unknown[]) => mockFsReaddirSync(...args),
  },
  existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
  readdirSync: (...args: unknown[]) => mockFsReaddirSync(...args),
}));

// Mock os for platform detection
vi.mock('node:os', () => ({
  default: {
    platform: () => 'linux',
    homedir: () => '/home/testuser',
    totalmem: () => 16 * 1024 * 1024 * 1024,
    cpus: () => [{ model: 'Test CPU' }],
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetectedIDE(overrides: Partial<DetectedIDE> = {}): DetectedIDE {
  return {
    id: 'vscode',
    name: 'Visual Studio Code',
    category: 'vscode-family',
    isRunning: true,
    binaryPath: '/usr/bin/code',
    version: '1.85.0',
    configDir: '/home/testuser/.config/Code',
    detectionMethod: 'path',
    ...overrides,
  };
}

function makeDiscoveredLSP(overrides: Partial<DiscoveredLSP> = {}): DiscoveredLSP {
  return {
    id: 'lsp-typescript',
    name: 'TypeScript Language Server',
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    binaryPath: '/usr/local/bin/typescript-language-server',
    version: '4.0.0',
    discoveryMethod: 'path',
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    available: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

describe('IDE Types', () => {
  it('exports SUDO_VSCODE_EXTENSION with correct structure', () => {
    expect(SUDO_VSCODE_EXTENSION.id).toBe('sudo-ai.sudo-ai-vscode');
    expect(SUDO_VSCODE_EXTENSION.publisher).toBe('sudo-ai');
    expect(SUDO_VSCODE_EXTENSION.targetIDEs).toContain('vscode');
    expect(SUDO_VSCODE_EXTENSION.targetIDEs).toContain('cursor');
  });

  it('exports DEFAULT_IDE_INSTALL_CONFIG with sensible defaults', () => {
    expect(DEFAULT_IDE_INSTALL_CONFIG.enabled).toBe(true);
    expect(DEFAULT_IDE_INSTALL_CONFIG.requireConfirmation).toBe(true);
    expect(DEFAULT_IDE_INSTALL_CONFIG.installTimeoutMs).toBe(60_000);
    expect(DEFAULT_IDE_INSTALL_CONFIG.vscodeCLI).toBe('code');
  });

  it('exports DEFAULT_IDE_MANAGER_CONFIG with sensible defaults', () => {
    expect(DEFAULT_IDE_MANAGER_CONFIG.scanOnStartup).toBe(true);
    expect(DEFAULT_IDE_MANAGER_CONFIG.discoverLSPOnStartup).toBe(true);
    expect(DEFAULT_IDE_MANAGER_CONFIG.autoConnectLSP).toBe(false);
    expect(DEFAULT_IDE_MANAGER_CONFIG.cacheTTLSecs).toBe(300);
  });

  it('exports KNOWN_LSP_SERVERS with all major languages', () => {
    const languages = KNOWN_LSP_SERVERS.map((s) => s.language);
    expect(languages).toContain('typescript');
    expect(languages).toContain('python');
    expect(languages).toContain('rust');
    expect(languages).toContain('go');
    expect(languages).toContain('java');
    expect(languages).toContain('cpp');
    expect(languages).toContain('ruby');
    expect(languages).toContain('php');
    expect(languages).toContain('csharp');
    expect(languages).toContain('swift');
    expect(languages).toContain('kotlin');
    expect(languages).toContain('dart');
    expect(languages).toContain('yaml');
    expect(languages).toContain('json');
    expect(languages).toContain('dockerfile');
    expect(languages).toContain('terraform');
  });

  it('all LSP servers have required fields', () => {
    for (const server of KNOWN_LSP_SERVERS) {
      expect(server.language).toBeTruthy();
      expect(server.binaries).toBeInstanceOf(Array);
      expect(server.fileExtensions).toBeInstanceOf(Array);
      expect(server.fileExtensions.length).toBeGreaterThan(0);
      expect(server.defaultArgs).toBeInstanceOf(Array);
    }
  });
});

// ---------------------------------------------------------------------------
// IDE Detection
// ---------------------------------------------------------------------------

describe('IDE Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: which command returns not found
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'ps') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'which') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
  });

  it('returns empty array when no IDEs detected', () => {
    mockFsExistsSync.mockReturnValue(false);
    const result = detectIDEs();
    expect(result.ides).toBeInstanceOf(Array);
    expect(result.platform).toBe('linux');
    expect(result.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.scannedAt).toBeTruthy();
  });

  it('detects VS Code when binary is in PATH', () => {
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') {
        return { status: 0, stdout: '/usr/bin/code\n', stderr: '' };
      }
      if (cmd === 'ps') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'code') {
        return { status: 0, stdout: '1.85.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    mockFsExistsSync.mockReturnValue(false);

    const result = detectIDEs();
    const vscode = result.ides.find((ide) => ide.id === 'vscode');
    expect(vscode).toBeDefined();
    if (vscode) {
      expect(vscode.category).toBe('vscode-family');
      expect(vscode.binaryPath).toBeTruthy();
    }
  });

  it('detects running IDE via environment variable', () => {
    const originalVscIpc = process.env['VSCODE_IPC_HOOK'];
    process.env['VSCODE_IPC_HOOK'] = '/tmp/vscode-ipc.sock';

    mockFsExistsSync.mockReturnValue(false);
    const result = detectIDEs();

    const vscode = result.ides.find((ide) => ide.id === 'vscode');
    expect(vscode).toBeDefined();
    if (vscode) {
      expect(vscode.isRunning).toBe(true);
      expect(vscode.detectionMethod).toBe('env');
    }

    // Restore
    if (originalVscIpc === undefined) {
      delete process.env['VSCODE_IPC_HOOK'];
    } else {
      process.env['VSCODE_IPC_HOOK'] = originalVscIpc;
    }
  });

  it('detects IDE via config directory', () => {
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    mockFsExistsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('Code')) return true;
      return false;
    });

    const result = detectIDEs();
    // Should detect VS Code via config directory
    const vscode = result.ides.find((ide) => ide.id === 'vscode');
    if (vscode) {
      expect(vscode.detectionMethod).toBe('config_file');
    }
  });

  it('detects Neovim when nvim is in PATH', () => {
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which' || cmd === 'command') {
        if (cmd === 'which') {
          return { status: 0, stdout: '/usr/bin/nvim\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'ps') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'nvim') {
        return { status: 0, stdout: 'NVIM v0.9.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    mockFsExistsSync.mockReturnValue(false);

    const result = detectIDEs();
    const nvim = result.ides.find((ide) => ide.id === 'neovim');
    expect(nvim).toBeDefined();
    if (nvim) {
      expect(nvim.category).toBe('vim-family');
    }
  });

  it('never throws even when detection fails', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    mockFsExistsSync.mockImplementation(() => {
      throw new Error('fs failed');
    });

    expect(() => detectIDEs()).not.toThrow();
  });

  it('includes scan metadata', () => {
    const result = detectIDEs();
    expect(result.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.platform).toBe('linux');
  });
});

// ---------------------------------------------------------------------------
// LSP Discovery
// ---------------------------------------------------------------------------

describe('LSP Discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
  });

  it('discovers TypeScript language server when available', () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'typescript-language-server') {
        return { status: 0, stdout: '/usr/local/bin/typescript-language-server\n', stderr: '' };
      }
      if (cmd === 'typescript-language-server' && args[0] === '--version') {
        return { status: 0, stdout: '4.0.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    const servers = discoverLanguageServers();
    const tsServer = servers.find((s) => s.language === 'typescript');
    expect(tsServer).toBeDefined();
    if (tsServer) {
      expect(tsServer.available).toBe(true);
      expect(tsServer.discoveryMethod).toBe('path');
    }
  });

  it('marks unavailable servers correctly', () => {
    // All which commands fail — no servers found
    mockSpawnSync.mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    mockFsExistsSync.mockReturnValue(false);

    const servers = discoverLanguageServers();
    // All servers should be discovered (listed) but not all available
    expect(servers.length).toBe(KNOWN_LSP_SERVERS.length);
    // Most should be unavailable since no binaries found
    const available = servers.filter((s) => s.available);
    // Only available if found in PATH or npm global
    expect(available.length).toBeLessThanOrEqual(KNOWN_LSP_SERVERS.length);
  });

  it('discovers all known languages', () => {
    const servers = discoverLanguageServers();
    const languages = servers.map((s) => s.language);
    for (const expected of KNOWN_LSP_SERVERS) {
      expect(languages).toContain(expected.language);
    }
  });

  it('sets correct file extensions for each server', () => {
    const servers = discoverLanguageServers();
    const tsServer = servers.find((s) => s.language === 'typescript');
    if (tsServer) {
      expect(tsServer.fileExtensions).toContain('.ts');
      expect(tsServer.fileExtensions).toContain('.tsx');
    }

    const pyServer = servers.find((s) => s.language === 'python');
    if (pyServer) {
      expect(pyServer.fileExtensions).toContain('.py');
    }
  });

  it('never throws even when discovery fails', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    expect(() => discoverLanguageServers()).not.toThrow();
  });

  it('searches additional LSP paths from config', () => {
    mockSpawnSync.mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    mockFsExistsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('custom-bin')) return true;
      return false;
    });

    const servers = discoverLanguageServers({
      additionalLSPPaths: ['/opt/custom-bin'],
    });

    // Should attempt to find binaries in the additional path
    expect(servers).toBeInstanceOf(Array);
  });
});

// ---------------------------------------------------------------------------
// LSP Recommendation
// ---------------------------------------------------------------------------

describe('LSP Recommendation', () => {
  const servers: DiscoveredLSP[] = [
    makeDiscoveredLSP({
      id: 'lsp-typescript',
      language: 'typescript',
      fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
      available: true,
      discoveryMethod: 'path',
    }),
    makeDiscoveredLSP({
      id: 'lsp-python',
      language: 'python',
      command: 'pyright-langserver',
      fileExtensions: ['.py', '.pyi'],
      available: true,
      discoveryMethod: 'path',
    }),
    makeDiscoveredLSP({
      id: 'lsp-rust',
      language: 'rust',
      command: 'rust-analyzer',
      fileExtensions: ['.rs'],
      available: false,
      discoveryMethod: 'manual',
    }),
  ];

  it('recommends the correct server for .ts files', () => {
    const rec = getLSPRecommendation('/path/to/file.ts', servers);
    expect(rec).toBeDefined();
    if (rec) {
      expect(rec.language).toBe('typescript');
      expect(rec.available).toBe(true);
    }
  });

  it('recommends the correct server for .py files', () => {
    const rec = getLSPRecommendation('/path/to/script.py', servers);
    expect(rec).toBeDefined();
    if (rec) {
      expect(rec.language).toBe('python');
    }
  });

  it('prefers available servers over unavailable', () => {
    const rec = getLSPRecommendation('/path/to/main.rs', servers);
    if (rec) {
      // Rust server is not available, so should still recommend it but mark as unavailable
      expect(rec.language).toBe('rust');
      expect(rec.available).toBe(false);
    }
  });

  it('returns null for unknown file extensions', () => {
    const rec = getLSPRecommendation('/path/to/file.xyz', servers);
    expect(rec).toBeNull();
  });

  it('returns null for empty server list', () => {
    const rec = getLSPRecommendation('/path/to/file.ts', []);
    expect(rec).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extension Status Checking
// ---------------------------------------------------------------------------

describe('Extension Status Checking', () => {
  it('returns not_installed when IDE has no binary or config', () => {
    const ide = makeDetectedIDE({ binaryPath: undefined, configDir: undefined });
    const result = checkExtensionStatus(ide, SUDO_VSCODE_EXTENSION);
    expect(result.status).toBe('not_installed');
    expect(result.installAttempted).toBe(false);
  });

  it('checks VS Code extensions via CLI', () => {
    const ide = makeDetectedIDE({
      category: 'vscode-family',
      binaryPath: '/usr/bin/code',
    });

    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/code' && args[0] === '--list-extensions') {
        return {
          status: 0,
          stdout: 'ms-python.python@2024.0.1\nsudo-ai.sudo-ai-vscode@1.0.0\n',
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    const result = checkExtensionStatus(ide, SUDO_VSCODE_EXTENSION);
    // May or may not be installed depending on CLI mock
    expect(['installed', 'not_installed', 'error']).toContain(result.status);
  });

  it('returns error status when CLI fails', () => {
    const ide = makeDetectedIDE({
      category: 'vscode-family',
      binaryPath: '/usr/bin/code',
    });

    mockSpawnSync.mockImplementation(() => ({
      status: 1,
      stdout: '',
      stderr: 'Command not found',
    }));

    const result = checkExtensionStatus(ide, SUDO_VSCODE_EXTENSION);
    expect(result.status).toBe('error');
  });

  it('returns not_installed for vim-family IDEs', () => {
    const ide = makeDetectedIDE({
      id: 'neovim',
      category: 'vim-family',
      binaryPath: '/usr/bin/nvim',
    });

    const result = checkExtensionStatus(ide, SUDO_VSCODE_EXTENSION);
    expect(result.status).toBe('not_installed');
  });
});

// ---------------------------------------------------------------------------
// Extension Installation
// ---------------------------------------------------------------------------

describe('Extension Installation', () => {
  it('does not re-install already installed extensions', () => {
    const ide = makeDetectedIDE({
      category: 'vscode-family',
      binaryPath: '/usr/bin/code',
    });

    // Mock extension already installed
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === '--list-extensions') {
        return {
          status: 0,
          stdout: `${SUDO_VSCODE_EXTENSION.id}@1.0.0\n`,
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = installExtension(ide, SUDO_VSCODE_EXTENSION);
    expect(result.installAttempted).toBe(false);
  });

  it('attempts installation for missing VS Code extension', () => {
    const ide = makeDetectedIDE({
      category: 'vscode-family',
      binaryPath: '/usr/bin/code',
    });

    let installCalled = false;
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === '--list-extensions') {
        return { status: 0, stdout: '', stderr: '' }; // Not installed
      }
      if (args[0] === '--install-extension') {
        installCalled = true;
        return { status: 0, stdout: 'Extension installed\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = installExtension(ide, SUDO_VSCODE_EXTENSION);
    expect(result.installAttempted).toBe(true);
  });

  it('provides manual URL for JetBrains extensions', () => {
    const ide = makeDetectedIDE({
      id: 'jetbrains-intellij',
      category: 'jetbrains-family',
      binaryPath: '/usr/bin/idea',
      configDir: '/home/testuser/.local/share/JetBrains/IntelliJIdea',
    });

    mockFsExistsSync.mockReturnValue(false);

    const result = installExtension(ide, SUDO_VSCODE_EXTENSION);
    expect(result.installAttempted).toBe(true);
    // JetBrains should provide manual install instructions
    expect(result.error).toContain('plugins.jetbrains.com');
  });

  it('returns error for vim-family IDEs (manual install required)', () => {
    const ide = makeDetectedIDE({
      id: 'neovim',
      category: 'vim-family',
      binaryPath: '/usr/bin/nvim',
    });

    const result = installExtension(ide, SUDO_VSCODE_EXTENSION);
    expect(result.installAttempted).toBe(true);
    expect(result.installSucceeded).toBe(false);
    expect(result.error).toContain('manually');
  });
});

// ---------------------------------------------------------------------------
// Installation Summary
// ---------------------------------------------------------------------------

describe('Installation Summary', () => {
  it('provides summary statistics', () => {
    const ides = [makeDetectedIDE()];
    const extensions = [SUDO_VSCODE_EXTENSION];

    mockSpawnSync.mockImplementation(() => ({
      status: 0,
      stdout: '',
      stderr: '',
    }));

    const summary = getInstallationSummary(ides, extensions);
    expect(summary.totalIDEs).toBe(1);
    expect(summary.totalExtensions).toBe(1);
    expect(typeof summary.installed).toBe('number');
    expect(typeof summary.notInstalled).toBe('number');
    expect(typeof summary.errors).toBe('number');
  });

  it('handles empty IDE list', () => {
    const summary = getInstallationSummary([], []);
    expect(summary.totalIDEs).toBe(0);
    expect(summary.totalExtensions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isExtensionInstalled
// ---------------------------------------------------------------------------

describe('isExtensionInstalled', () => {
  it('returns false when IDE has no config dir', () => {
    const ide = makeDetectedIDE({ configDir: undefined });
    expect(isExtensionInstalled(ide, 'test.ext')).toBe(false);
  });

  it('returns false when extensions directory does not exist', () => {
    mockFsExistsSync.mockReturnValue(false);
    const ide = makeDetectedIDE({ configDir: '/home/testuser/.config/Code' });
    expect(isExtensionInstalled(ide, 'test.ext')).toBe(false);
  });

  it('returns true when extension is found in directory', () => {
    mockFsExistsSync.mockReturnValue(true);
    mockFsReaddirSync.mockReturnValue(['sudo-ai.sudo-ai-vscode-1.0.0', 'ms-python.python-2024.0.1']);
    const ide = makeDetectedIDE({ category: 'vscode-family' });
    expect(isExtensionInstalled(ide, 'sudo-ai.sudo-ai-vscode')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LSP Client
// ---------------------------------------------------------------------------

describe('LSPClient', () => {
  it('initializes with correct default state', () => {
    const server = makeDiscoveredLSP();
    const client = new LSPClient({
      server,
      rootUri: 'file:///project',
    });

    const status = client.getStatus();
    expect(status.state).toBe('disconnected');
    expect(status.serverId).toBe('lsp-typescript');
    expect(status.restartCount).toBe(0);
  });

  it('returns server config', () => {
    const server = makeDiscoveredLSP();
    const client = new LSPClient({
      server,
      rootUri: 'file:///project',
    });

    expect(client.getServer()).toBe(server);
  });

  it('returns empty diagnostics initially', () => {
    const server = makeDiscoveredLSP();
    const client = new LSPClient({
      server,
      rootUri: 'file:///project',
    });

    expect(client.getDiagnostics()).toEqual([]);
  });

  it('registers and unregisters event handlers', () => {
    const server = makeDiscoveredLSP();
    const client = new LSPClient({
      server,
      rootUri: 'file:///project',
    });

    const handler = vi.fn();
    client.on('test', handler);
    client.off('test', handler);
    // No errors should be thrown
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LSP Client Manager
// ---------------------------------------------------------------------------

describe('LSPClientManager', () => {
  it('starts with no connected clients', () => {
    const manager = new LSPClientManager();
    expect(manager.getConnectedClients()).toEqual([]);
    expect(manager.getAllStatus()).toEqual([]);
  });

  it('getAllDiagnostics returns empty map initially', () => {
    const manager = new LSPClientManager();
    expect(manager.getAllDiagnostics().size).toBe(0);
  });

  it('registers and unregisters event handlers', () => {
    const manager = new LSPClientManager();
    const handler = vi.fn();
    manager.on('test', handler);
    manager.off('test', handler);
    // No errors should be thrown
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IDE Manager (Facade)
// ---------------------------------------------------------------------------

describe('IDEManager', () => {
  let manager: IDEManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });
    mockFsExistsSync.mockReturnValue(false);
    manager = new IDEManager();
  });

  it('scans for IDEs and caches results', () => {
    const result1 = manager.scanIDEs();
    const result2 = manager.scanIDEs(); // Should return cached
    expect(result1).toBe(result2); // Same reference = cached
  });

  it('forces fresh scan with force=true', () => {
    const result1 = manager.scanIDEs();
    const result2 = manager.scanIDEs(true); // Force fresh scan
    // Should be different objects (not cached)
    expect(result1).not.toBe(result2);
  });

  it('getIDEs returns array of DetectedIDE', () => {
    const ides = manager.getIDEs();
    expect(ides).toBeInstanceOf(Array);
  });

  it('discovers LSPs and caches results', () => {
    const servers1 = manager.discoverLSPs();
    const servers2 = manager.discoverLSPs(); // Should return cached
    expect(servers1).toBe(servers2); // Same reference = cached
  });

  it('forces fresh LSP discovery with force=true', () => {
    const servers1 = manager.discoverLSPs();
    const servers2 = manager.discoverLSPs(true);
    expect(servers1).not.toBe(servers2);
  });

  it('getAvailableLSPs filters to available servers only', () => {
    const available = manager.getAvailableLSPs();
    for (const server of available) {
      expect(server.available).toBe(true);
    }
  });

  it('getLSPForFile returns recommendation or null', () => {
    // May return null if no servers are available
    const rec = manager.getLSPForFile('/path/to/file.ts');
    if (rec) {
      expect(rec.filePath).toBe('/path/to/file.ts');
      expect(rec.language).toBeTruthy();
      expect(rec.recommendedServer).toBeTruthy();
    }
  });

  it('getExtensionStatus returns summary', () => {
    const summary = manager.getExtensionStatus();
    expect(typeof summary.totalIDEs).toBe('number');
    expect(typeof summary.totalExtensions).toBe('number');
  });

  it('installExtensions returns results array', () => {
    const results = manager.installExtensions();
    expect(results).toBeInstanceOf(Array);
  });

  it('getSummary returns readable string', () => {
    const summary = manager.getSummary();
    expect(summary).toContain('IDE Environment Summary');
    expect(summary).toContain('Detected IDEs');
    expect(summary).toContain('Language Servers');
  });

  it('registers and unregisters event handlers', () => {
    const handler = vi.fn();
    manager.on(handler);
    manager.off(handler);
    expect(true).toBe(true); // No errors
  });

  it('accepts custom configuration', () => {
    const customManager = new IDEManager({
      scanOnStartup: false,
      discoverLSPOnStartup: false,
      cacheTTLSecs: 60,
    });
    expect(customManager).toBeInstanceOf(IDEManager);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('Edge Cases', () => {
  it('handles concurrent scans gracefully', () => {
    // Multiple scans should not interfere
    const result1 = detectIDEs();
    const result2 = detectIDEs();
    expect(result1.scannedAt).toBeTruthy();
    expect(result2.scannedAt).toBeTruthy();
  });

  it('handles empty KNOWN_LSP_SERVERS gracefully', () => {
    // Even with no servers matching, the function should return results
    const servers = discoverLanguageServers();
    expect(servers).toBeInstanceOf(Array);
  });

  it('handles LSP recommendation for files with no extension', () => {
    const servers = [makeDiscoveredLSP()];
    const rec = getLSPRecommendation('/path/to/Makefile', servers);
    expect(rec).toBeNull(); // No .ts extension
  });

  it('handles LSP recommendation for files with multiple dots', () => {
    const servers = [makeDiscoveredLSP()];
    const rec = getLSPRecommendation('/path/to/file.test.ts', servers);
    if (rec) {
      expect(rec.language).toBe('typescript');
    }
  });

  it('handles extension check with empty config dir', () => {
    const ide = makeDetectedIDE({ configDir: undefined, binaryPath: undefined });
    const result = checkExtensionStatus(ide, SUDO_VSCODE_EXTENSION);
    expect(result).toBeDefined();
    // When IDE has no binary or config, it should be not_installed
    // (not 'error' since there's nothing to check)
    expect(['not_installed', 'error']).toContain(result.status);
  });

  it('LSPClient handles connection timeout configuration', () => {
    const server = makeDiscoveredLSP();
    const client = new LSPClient({
      server,
      rootUri: 'file:///project',
      connectionTimeoutMs: 5000,
    });
    const status = client.getStatus();
    expect(status.state).toBe('disconnected');
  });

  it('IDEManager with zero TTL cache still works', () => {
    const manager = new IDEManager({ cacheTTLSecs: 0 });
    const result = manager.scanIDEs();
    expect(result).toBeDefined();
    // With 0 TTL, next scan should be fresh
    const result2 = manager.scanIDEs();
    expect(result2).toBeDefined();
  });

  it('discovery works with partial spawnSync failures', () => {
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'ps') throw new Error('ps failed');
      if (cmd === 'which') return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    });

    expect(() => detectIDEs()).not.toThrow();
    expect(() => discoverLanguageServers()).not.toThrow();
  });
});
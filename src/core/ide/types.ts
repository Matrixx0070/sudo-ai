/**
 * @file ide/types.ts
 * @description Type definitions for IDE auto-detection, extension installation,
 * and Language Server Protocol (LSP) discovery.
 *
 * Competitive context: Claude Code has IDE auto-install (VS Code + JetBrains)
 * and an LSP recommendation system (lspRecommendation). This module provides
 * SUDO-AI's equivalent — auto-detecting running IDEs, installing extensions,
 * discovering language servers, and managing LSP connections.
 *
 * @module ide-types
 */

// ---------------------------------------------------------------------------
// IDE Detection
// ---------------------------------------------------------------------------

/** Supported IDE identifiers. */
export type IDEId =
  | 'vscode'
  | 'vscode-insiders'
  | 'cursor'
  | 'jetbrains-intellij'
  | 'jetbrains-webstorm'
  | 'jetbrains-pycharm'
  | 'jetbrains-goland'
  | 'jetbrains-clion'
  | 'jetbrains-rider'
  | 'jetbrains-rubymine'
  | 'jetbrains-phpstorm'
  | 'jetbrains-datagrip'
  | 'neovim'
  | 'vim'
  | 'emacs';

/** Category grouping for IDEs. */
export type IDECategory = 'vscode-family' | 'jetbrains-family' | 'vim-family';

/** Detected IDE on the host system. */
export interface DetectedIDE {
  /** Unique IDE identifier. */
  id: IDEId;
  /** Human-readable name (e.g., 'Visual Studio Code'). */
  name: string;
  /** Category grouping. */
  category: IDECategory;
  /** Whether the IDE is currently running. */
  isRunning: boolean;
  /** Absolute path to the IDE binary (if found). */
  binaryPath?: string;
  /** Detected version string (if available). */
  version?: string;
  /** Absolute path to the IDE's extension/config directory. */
  configDir?: string;
  /** How this IDE was detected. */
  detectionMethod: 'process' | 'path' | 'env' | 'config_file' | 'manual';
}

/** Result of scanning the host for IDEs. */
export interface IDEScanResult {
  /** All detected IDEs. */
  ides: DetectedIDE[];
  /** Timestamp of the scan. */
  scannedAt: string;
  /** Duration of the scan in milliseconds. */
  scanDurationMs: number;
  /** Platform the scan ran on. */
  platform: 'linux' | 'darwin' | 'win32' | 'unknown';
}

// ---------------------------------------------------------------------------
// IDE Extension Installation
// ---------------------------------------------------------------------------

/** Status of an IDE extension. */
export type ExtensionStatus = 'installed' | 'outdated' | 'not_installed' | 'error';

/** A marketplace extension identifier. */
export interface ExtensionId {
  /** Marketplace identifier (e.g., 'anthropic.claude-code' for VS Code). */
  id: string;
  /** Human-readable extension name. */
  name: string;
  /** Extension publisher/namespace. */
  publisher: string;
  /** Which IDEs this extension targets. */
  targetIDEs: IDEId[];
}

/** Result of checking/installing an extension. */
export interface ExtensionResult {
  /** The extension that was checked/installed. */
  extension: ExtensionId;
  /** Current status. */
  status: ExtensionStatus;
  /** Installed version (if installed). */
  installedVersion?: string;
  /** Latest available version. */
  latestVersion?: string;
  /** Error message (if status is 'error'). */
  error?: string;
  /** Whether an installation was attempted. */
  installAttempted: boolean;
  /** Whether the installation succeeded. */
  installSucceeded: boolean;
}

/** Configuration for IDE auto-install. */
export interface IDEInstallConfig {
  /** Whether auto-install is enabled (default: true). */
  enabled: boolean;
  /** Whether to prompt before installing (default: true). */
  requireConfirmation: boolean;
  /** Extensions to auto-install. */
  extensions: ExtensionId[];
  /** VS Code CLI command (default: 'code'). */
  vscodeCLI: string;
  /** JetBrains plugin manager command (default: auto-detected). */
  jetbrainsCLI?: string;
  /** Maximum time to wait for installation (ms, default: 60000). */
  installTimeoutMs: number;
  /** Whether to check for updates on startup (default: true). */
  checkUpdatesOnStartup: boolean;
}

// ---------------------------------------------------------------------------
// LSP Discovery
// ---------------------------------------------------------------------------

/** A discovered language server. */
export interface DiscoveredLSP {
  /** Unique identifier for this language server. */
  id: string;
  /** Human-readable name (e.g., 'TypeScript Language Server'). */
  name: string;
  /** Language this server supports. */
  language: string;
  /** Binary command to start the server. */
  command: string;
  /** Arguments to pass to the command. */
  args: string[];
  /** Absolute path to the server binary (if found). */
  binaryPath?: string;
  /** Detected version (if available). */
  version?: string;
  /** How this server was discovered. */
  discoveryMethod: 'path' | 'npm_global' | 'vscode_extension' | 'jetbrains_plugin' | 'config' | 'manual';
  /** File extensions this server can handle. */
  fileExtensions: string[];
  /** Whether the server is currently available on this system. */
  available: boolean;
  /** Minimum SUDO-AI version required (optional). */
  minVersion?: string;
}

/** LSP server configuration for a specific project. */
export interface LSPProjectConfig {
  /** Map of language to LSP server ID. */
  servers: Record<string, string>;
  /** Custom initialization options per server. */
  initOptions?: Record<string, Record<string, unknown>>;
  /** Custom settings per server. */
  settings?: Record<string, Record<string, unknown>>;
}

/** LSP recommendation for a file. */
export interface LSPRecommendation {
  /** File path being analyzed. */
  filePath: string;
  /** Detected language. */
  language: string;
  /** Recommended LSP server. */
  recommendedServer: DiscoveredLSP;
  /** Alternative servers (if multiple are available). */
  alternatives: DiscoveredLSP[];
  /** Whether the recommended server is installed. */
  isInstalled: boolean;
  /** Confidence of the recommendation (0-1). */
  confidence: number;
}

// ---------------------------------------------------------------------------
// LSP Client Connection
// ---------------------------------------------------------------------------

/** LSP client connection state. */
export type LSPConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'initializing'
  | 'ready'
  | 'error'
  | 'stopped';

/** LSP client connection configuration. */
export interface LSPClientConfig {
  /** The language server to connect to. */
  server: DiscoveredLSP;
  /** Working directory for the language server. */
  rootUri: string;
  /** Custom initialization options. */
  initOptions?: Record<string, unknown>;
  /** Custom LSP settings. */
  settings?: Record<string, unknown>;
  /** Connection timeout in ms (default: 10000). */
  connectionTimeoutMs?: number;
  /** Whether to auto-restart on crash (default: true). */
  autoRestart?: boolean;
  /** Maximum restart attempts before giving up (default: 3). */
  maxRestartAttempts?: number;
}

/** LSP client connection status. */
export interface LSPConnectionStatus {
  /** The connected server. */
  serverId: string;
  /** Current connection state. */
  state: LSPConnectionState;
  /** Number of restarts attempted. */
  restartCount: number;
  /** Last error (if state is 'error'). */
  lastError?: string;
  /** Connected at (ISO timestamp). */
  connectedAt?: string;
  /** Server capabilities (once initialized). */
  capabilities?: Record<string, unknown>;
}

/** An LSP diagnostic (error/warning from language server). */
export interface LSPDiagnostic {
  /** File URI. */
  uri: string;
  /** Diagnostic severity. */
  severity: 'error' | 'warning' | 'information' | 'hint';
  /** Line number (0-based). */
  line: number;
  /** Column number (0-based). */
  character: number;
  /** End line (0-based, optional). */
  endLine?: number;
  /** End column (0-based, optional). */
  endCharacter?: number;
  /** Diagnostic message. */
  message: string;
  /** Source of the diagnostic (e.g., 'ts'). */
  source?: string;
  /** Diagnostic code (optional). */
  code?: string | number;
}

// ---------------------------------------------------------------------------
// IDE Manager Configuration
// ---------------------------------------------------------------------------

/** Top-level configuration for the IDE module. */
export interface IDEManagerConfig {
  /** IDE auto-install configuration. */
  install: IDEInstallConfig;
  /** Whether to scan for IDEs on startup (default: true). */
  scanOnStartup: boolean;
  /** Whether to discover LSP servers on startup (default: true). */
  discoverLSPOnStartup: boolean;
  /** Whether to auto-connect to relevant LSP servers (default: false). */
  autoConnectLSP: boolean;
  /** Custom LSP project configuration. */
  lspProjectConfig?: LSPProjectConfig;
  /** Additional LSP server paths to search. */
  additionalLSPPaths: string[];
  /** Whether to cache scan results (default: true). */
  cacheResults: boolean;
  /** Cache TTL in seconds (default: 300). */
  cacheTTLSecs: number;
}

/** Known LSP servers that SUDO-AI can discover. */
export interface LSPServerRegistry {
  /** Language name. */
  language: string;
  /** Common binary names. */
  binaries: string[];
  /** Common npm package names (for global installs). */
  npmPackages: string[];
  /** VS Code extension IDs that bundle this server. */
  vscodeExtensions: string[];
  /** JetBrains plugin IDs that bundle this server. */
  jetbrainsPlugins: string[];
  /** Default arguments. */
  defaultArgs: string[];
  /** File extensions this server handles. */
  fileExtensions: string[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Events emitted by the IDE manager. */
export type IDEEvent =
  | { type: 'ide_detected'; ide: DetectedIDE }
  | { type: 'extension_installed'; extension: ExtensionId; ide: IDEId }
  | { type: 'extension_install_failed'; extension: ExtensionId; ide: IDEId; error: string }
  | { type: 'lsp_discovered'; lsp: DiscoveredLSP }
  | { type: 'lsp_connected'; lspId: string }
  | { type: 'lsp_disconnected'; lspId: string; error?: string }
  | { type: 'lsp_recommendation'; recommendation: LSPRecommendation };

/** Event handler callback. */
export type IDEEventHandler = (event: IDEEvent) => void;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default SUDO-AI extension for VS Code. */
export const SUDO_VSCODE_EXTENSION: ExtensionId = {
  id: 'sudo-ai.sudo-ai-vscode',
  name: 'SUDO-AI',
  publisher: 'sudo-ai',
  targetIDEs: ['vscode', 'vscode-insiders', 'cursor'],
};

/** Default install configuration. */
export const DEFAULT_IDE_INSTALL_CONFIG: IDEInstallConfig = {
  enabled: true,
  requireConfirmation: true,
  extensions: [SUDO_VSCODE_EXTENSION],
  vscodeCLI: 'code',
  installTimeoutMs: 60_000,
  checkUpdatesOnStartup: true,
};

/** Default IDE manager configuration. */
export const DEFAULT_IDE_MANAGER_CONFIG: IDEManagerConfig = {
  install: DEFAULT_IDE_INSTALL_CONFIG,
  scanOnStartup: true,
  discoverLSPOnStartup: true,
  autoConnectLSP: false,
  additionalLSPPaths: [],
  cacheResults: true,
  cacheTTLSecs: 300,
};

/** Known LSP server registry — maps languages to their discoverable servers. */
export const KNOWN_LSP_SERVERS: LSPServerRegistry[] = [
  {
    language: 'typescript',
    binaries: ['typescript-language-server', 'ts-node', 'tsserver'],
    npmPackages: ['typescript-language-server', 'typescript'],
    vscodeExtensions: ['ms-vscode.vscode-typescript-next'],
    jetbrainsPlugins: ['com.intellij.typescript'],
    defaultArgs: ['--stdio'],
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    language: 'python',
    binaries: ['pylsp', 'pyright-langserver', 'ruff-lsp', 'pylsp-venv'],
    npmPackages: ['pyright', '@vscode/pyright-langserver'],
    vscodeExtensions: ['ms-python.python', 'ms-python.vscode-pylance'],
    jetbrainsPlugins: ['com.jetbrains.python'],
    defaultArgs: ['--stdio'],
    fileExtensions: ['.py', '.pyi', '.pyw'],
  },
  {
    language: 'rust',
    binaries: ['rust-analyzer'],
    npmPackages: [],
    vscodeExtensions: ['rust-lang.rust-analyzer'],
    jetbrainsPlugins: ['org.rust.ide'],
    defaultArgs: [],
    fileExtensions: ['.rs'],
  },
  {
    language: 'go',
    binaries: ['gopls'],
    npmPackages: [],
    vscodeExtensions: ['golang.go'],
    jetbrainsPlugins: ['com.jetbrains.go'],
    defaultArgs: [],
    fileExtensions: ['.go'],
  },
  {
    language: 'csharp',
    binaries: ['omnisharp', 'dotnet-csharp-ls'],
    npmPackages: ['omnisharp'],
    vscodeExtensions: ['ms-dotnettools.csharp'],
    jetbrainsPlugins: ['com.intellij.rider'],
    defaultArgs: ['--stdio'],
    fileExtensions: ['.cs', '.csx'],
  },
  {
    language: 'java',
    binaries: ['jdtls'],
    npmPackages: [],
    vscodeExtensions: ['redhat.java'],
    jetbrainsPlugins: ['com.intellij.java'],
    defaultArgs: [],
    fileExtensions: ['.java'],
  },
  {
    language: 'cpp',
    binaries: ['clangd', 'ccls'],
    npmPackages: [],
    vscodeExtensions: ['llvm-vs-code-extensions.vscode-clangd'],
    jetbrainsPlugins: ['com.jetbrains.clion'],
    defaultArgs: [],
    fileExtensions: ['.c', '.cpp', '.h', '.hpp', '.cc', '.cxx'],
  },
  {
    language: 'ruby',
    binaries: ['solargraph', 'steep', 'typeprof'],
    npmPackages: [],
    vscodeExtensions: ['castwide.solargraph'],
    jetbrainsPlugins: ['com.jetbrains.ruby'],
    defaultArgs: ['stdio'],
    fileExtensions: ['.rb', '.rake', '.gemspec'],
  },
  {
    language: 'php',
    binaries: ['php-language-server', 'intelephense'],
    npmPackages: ['intelephense', 'php-language-server'],
    vscodeExtensions: ['bmewburn.vscode-intelephense-client'],
    jetbrainsPlugins: ['com.jetbrains.php'],
    defaultArgs: ['--stdio'],
    fileExtensions: ['.php', '.phtml'],
  },
  {
    language: 'swift',
    binaries: ['sourcekit-lsp'],
    npmPackages: [],
    vscodeExtensions: ['sswg.swift-lang'],
    jetbrainsPlugins: [],
    defaultArgs: [],
    fileExtensions: ['.swift'],
  },
  {
    language: 'kotlin',
    binaries: ['kotlin-language-server'],
    npmPackages: ['kotlin-language-server'],
    vscodeExtensions: ['fwcd.kotlin'],
    jetbrainsPlugins: ['com.jetbrains.kotlin'],
    defaultArgs: ['--stdio'],
    fileExtensions: ['.kt', '.kts'],
  },
  {
    language: 'dart',
    binaries: ['dart', 'dart-language-server'],
    npmPackages: [],
    vscodeExtensions: ['dart-code.dart-code'],
    jetbrainsPlugins: ['com.jetbrains.dart'],
    defaultArgs: ['language-server', '--protocol=lsp'],
    fileExtensions: ['.dart'],
  },
  {
    language: 'yaml',
    binaries: ['yaml-language-server'],
    npmPackages: ['yaml-language-server'],
    vscodeExtensions: ['redhat.vscode-yaml'],
    jetbrainsPlugins: [],
    defaultArgs: ['--stdio'],
    fileExtensions: ['.yaml', '.yml'],
  },
  {
    language: 'json',
    binaries: ['vscode-json-languageserver'],
    npmPackages: ['vscode-langservers-extracted'],
    vscodeExtensions: [],
    jetbrainsPlugins: [],
    defaultArgs: ['--stdio'],
    fileExtensions: ['.json', '.jsonc'],
  },
  {
    language: 'dockerfile',
    binaries: ['docker-langserver'],
    npmPackages: ['dockerfile-language-server-nodejs'],
    vscodeExtensions: ['ms-azuretools.vscode-docker'],
    jetbrainsPlugins: [],
    defaultArgs: ['--stdio'],
    fileExtensions: ['Dockerfile', '.dockerfile'],
  },
  {
    language: 'terraform',
    binaries: ['terraform-ls'],
    npmPackages: [],
    vscodeExtensions: ['hashicorp.terraform'],
    jetbrainsPlugins: [],
    defaultArgs: ['serve'],
    fileExtensions: ['.tf', '.tfvars'],
  },
];
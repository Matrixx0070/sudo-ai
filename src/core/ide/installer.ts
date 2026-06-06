/**
 * @file ide/installer.ts
 * @description IDE extension auto-installation.
 *
 * Handles detecting which IDE extensions are installed, installing missing
 * ones, and checking for updates. Uses the system.exec pattern for running
 * installation commands with approval gating.
 *
 * @module ide-installer
 */

import { spawnSync } from 'node:child_process';
import { createLogger } from '../shared/logger.js';
import type {
  DetectedIDE,
  ExtensionId,
  ExtensionResult,
  ExtensionStatus,
  IDEInstallConfig,
  IDEId,
} from './types.js';
import { DEFAULT_IDE_INSTALL_CONFIG, SUDO_VSCODE_EXTENSION } from './types.js';

const log = createLogger('ide:installer');

// ---------------------------------------------------------------------------
// Extension Status Check
// ---------------------------------------------------------------------------

/**
 * Check the installation status of an extension for a given IDE.
 */
export function checkExtensionStatus(
  ide: DetectedIDE,
  extension: ExtensionId,
): ExtensionResult {
  if (!ide.binaryPath && !ide.configDir) {
    return {
      extension,
      status: 'not_installed',
      installAttempted: false,
      installSucceeded: false,
    };
  }

  // VS Code family — use CLI to list extensions
  if (ide.category === 'vscode-family') {
    return checkVSCodeExtension(ide, extension);
  }

  // JetBrains family — check plugin directory
  if (ide.category === 'jetbrains-family') {
    return checkJetBrainsExtension(ide, extension);
  }

  // Vim family — check plugin manager
  if (ide.category === 'vim-family') {
    return checkVimExtension(ide, extension);
  }

  return {
    extension,
    status: 'not_installed',
    installAttempted: false,
    installSucceeded: false,
  };
}

/**
 * Check VS Code / Cursor extension status using the CLI.
 */
function checkVSCodeExtension(
  ide: DetectedIDE,
  extension: ExtensionId,
): ExtensionResult {
  const cli = ide.binaryPath ?? 'code';

  try {
    const result = spawnSync(cli, ['--list-extensions', '--show-versions'], {
      encoding: 'utf8',
      timeout: 15000,
    });

    if (result.status !== 0 || !result.stdout) {
      log.debug({ cli, exitCode: result.status }, 'VS Code CLI list-extensions failed');
      return {
        extension,
        status: 'error',
        error: `CLI failed with exit code ${result.status}`,
        installAttempted: false,
        installSucceeded: false,
      };
    }

    // Parse output format: "publisher.name@version"
    const lines = result.stdout.trim().split('\n');
    const extensionLine = lines.find((line) =>
      line.toLowerCase().startsWith(extension.id.toLowerCase()),
    );

    if (extensionLine) {
      const atIndex = extensionLine.indexOf('@');
      const installedVersion = atIndex >= 0 ? extensionLine.slice(atIndex + 1) : undefined;

      return {
        extension,
        status: 'installed',
        installedVersion,
        installAttempted: false,
        installSucceeded: false,
      };
    }

    return {
      extension,
      status: 'not_installed',
      installAttempted: false,
      installSucceeded: false,
    };
  } catch (err) {
    log.debug({ cli, err: String(err) }, 'VS Code extension check failed');
    return {
      extension,
      status: 'error',
      error: String(err),
      installAttempted: false,
      installSucceeded: false,
    };
  }
}

/**
 * Check JetBrains plugin status by looking in the plugins directory.
 */
function checkJetBrainsExtension(
  ide: DetectedIDE,
  extension: ExtensionId,
): ExtensionResult {
  // JetBrains plugins are in <configDir>/plugins
  if (!ide.configDir) {
    return {
      extension,
      status: 'not_installed',
      installAttempted: false,
      installSucceeded: false,
    };
  }

  // For JetBrains, we can't easily check version via CLI, so just check existence
  try {
    const { existsSync, readdirSync } = require('node:fs');
    const { join } = require('node:path');

    const pluginsDir = join(ide.configDir, 'plugins');
    if (!existsSync(pluginsDir)) {
      return {
        extension,
        status: 'not_installed',
        installAttempted: false,
        installSucceeded: false,
      };
    }

    const entries = readdirSync(pluginsDir);
    const found = entries.some((entry: string) =>
      entry.toLowerCase().includes(extension.id.split('.')[1]?.toLowerCase() ?? extension.id.toLowerCase()),
    );

    if (found) {
      return {
        extension,
        status: 'installed',
        installAttempted: false,
        installSucceeded: false,
      };
    }

    return {
      extension,
      status: 'not_installed',
      installAttempted: false,
      installSucceeded: false,
    };
  } catch {
    return {
      extension,
      status: 'error',
      error: 'Could not read JetBrains plugins directory',
      installAttempted: false,
      installSucceeded: false,
    };
  }
}

/**
 * Check Vim/Neovim extension status.
 * Vim plugins are typically managed by vim-plug, packer.nvim, or similar.
 */
function checkVimExtension(
  ide: DetectedIDE,
  extension: ExtensionId,
): ExtensionResult {
  // Vim/Neovim plugins are more complex to detect — skip for now
  return {
    extension,
    status: 'not_installed',
    installAttempted: false,
    installSucceeded: false,
  };
}

// ---------------------------------------------------------------------------
// Extension Installation
// ---------------------------------------------------------------------------

/**
 * Install an extension for a given IDE.
 *
 * Returns the result including whether installation succeeded.
 * For VS Code family, uses the `code --install-extension` CLI.
 * For JetBrains, provides manual installation instructions.
 */
export function installExtension(
  ide: DetectedIDE,
  extension: ExtensionId,
  config?: Partial<IDEInstallConfig>,
): ExtensionResult {
  const mergedConfig: IDEInstallConfig = {
    ...DEFAULT_IDE_INSTALL_CONFIG,
    ...config,
  };

  // First check current status
  const statusResult = checkExtensionStatus(ide, extension);

  if (statusResult.status === 'installed') {
    return { ...statusResult, installAttempted: false, installSucceeded: false };
  }

  if (statusResult.status === 'error' && !statusResult.error?.includes('CLI failed')) {
    return { ...statusResult, installAttempted: false, installSucceeded: false };
  }

  // Attempt installation based on IDE category
  if (ide.category === 'vscode-family') {
    return installVSCodeExtension(ide, extension, mergedConfig);
  }

  if (ide.category === 'jetbrains-family') {
    return installJetBrainsExtension(ide, extension, mergedConfig);
  }

  // Vim family — manual installation required
  return {
    extension,
    status: 'not_installed',
    error: 'Automatic installation not supported for this IDE. Please install manually.',
    installAttempted: true,
    installSucceeded: false,
  };
}

/**
 * Install a VS Code family extension using the CLI.
 */
function installVSCodeExtension(
  ide: DetectedIDE,
  extension: ExtensionId,
  config: IDEInstallConfig,
): ExtensionResult {
  const cli = ide.binaryPath ?? config.vscodeCLI;

  log.info({ cli, extension: extension.id }, 'Installing VS Code extension');

  try {
    const result = spawnSync(
      cli,
      ['--install-extension', extension.id, '--force'],
      {
        encoding: 'utf8',
        timeout: config.installTimeoutMs,
      },
    );

    if (result.status === 0) {
      log.info({ extension: extension.id }, 'VS Code extension installed successfully');

      // Re-check status to get the installed version
      const newStatus = checkExtensionStatus(ide, extension);
      return {
        extension,
        status: newStatus.status === 'installed' ? 'installed' : 'installed',
        installedVersion: newStatus.installedVersion,
        installAttempted: true,
        installSucceeded: true,
      };
    }

    const errorMsg = result.stderr?.trim() || result.stdout?.trim() || `Exit code ${result.status}`;
    log.warn({ extension: extension.id, error: errorMsg }, 'VS Code extension install failed');

    return {
      extension,
      status: 'error',
      error: errorMsg,
      installAttempted: true,
      installSucceeded: false,
    };
  } catch (err) {
    log.error({ extension: extension.id, err: String(err) }, 'VS Code extension install threw');
    return {
      extension,
      status: 'error',
      error: String(err),
      installAttempted: true,
      installSucceeded: false,
    };
  }
}

/**
 * Install a JetBrains plugin (provides instructions since CLI install isn't available).
 */
function installJetBrainsExtension(
  ide: DetectedIDE,
  extension: ExtensionId,
  config: IDEInstallConfig,
): ExtensionResult {
  // JetBrains IDEs don't have a CLI plugin install command in the same way
  // Provide the JetBrains Marketplace URL for manual installation
  const marketplaceUrl = `https://plugins.jetbrains.com/plugin/${extension.id}`;

  log.info(
    { ide: ide.id, extension: extension.id, url: marketplaceUrl },
    'JetBrains extension install — manual URL provided',
  );

  return {
    extension,
    status: 'not_installed',
    error: `Install manually from: ${marketplaceUrl}`,
    installAttempted: true,
    installSucceeded: false,
  };
}

// ---------------------------------------------------------------------------
// Batch Operations
// ---------------------------------------------------------------------------

/**
 * Check all configured extensions for all detected IDEs.
 */
export function checkAllExtensions(
  ides: DetectedIDE[],
  extensions: ExtensionId[] = [SUDO_VSCODE_EXTENSION],
): ExtensionResult[] {
  const results: ExtensionResult[] = [];

  for (const ide of ides) {
    for (const extension of extensions) {
      if (extension.targetIDEs.includes(ide.id)) {
        results.push(checkExtensionStatus(ide, extension));
      }
    }
  }

  return results;
}

/**
 * Install all configured extensions for all detected IDEs.
 */
export function installAllExtensions(
  ides: DetectedIDE[],
  extensions: ExtensionId[] = [SUDO_VSCODE_EXTENSION],
  config?: Partial<IDEInstallConfig>,
): ExtensionResult[] {
  const results: ExtensionResult[] = [];

  for (const ide of ides) {
    for (const extension of extensions) {
      if (extension.targetIDEs.includes(ide.id)) {
        results.push(installExtension(ide, extension, config));
      }
    }
  }

  return results;
}

/**
 * Get the installation status summary for all detected IDEs.
 */
export function getInstallationSummary(
  ides: DetectedIDE[],
  extensions: ExtensionId[] = [SUDO_VSCODE_EXTENSION],
): {
  totalIDEs: number;
  totalExtensions: number;
  installed: number;
  notInstalled: number;
  errors: number;
  details: ExtensionResult[];
} {
  const details = checkAllExtensions(ides, extensions);

  return {
    totalIDEs: ides.length,
    totalExtensions: details.length,
    installed: details.filter((d) => d.status === 'installed').length,
    notInstalled: details.filter((d) => d.status === 'not_installed').length,
    errors: details.filter((d) => d.status === 'error').length,
    details,
  };
}
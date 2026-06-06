/**
 * @file ide/index.ts
 * @description IDE integration module — auto-detection, extension installation,
 * and Language Server Protocol discovery and management.
 *
 * Exports:
 * - detectIDEs: Scan host for running/installed IDEs
 * - discoverLanguageServers: Find available LSP servers on the system
 * - getLSPRecommendation: Get the best LSP server for a file
 * - checkExtensionStatus / installExtension: IDE extension management
 * - LSPClient / LSPClientManager: LSP connection management
 * - All IDE/LSP types
 *
 * Usage:
 * ```ts
 * import { detectIDEs, discoverLanguageServers, IDEManager } from '../core/ide/index.js';
 *
 * // Scan for IDEs
 * const scanResult = detectIDEs();
 * console.log(`Found ${scanResult.ides.length} IDEs`);
 *
 * // Discover language servers
 * const servers = discoverLanguageServers();
 * const available = servers.filter(s => s.available);
 *
 * // Get recommendation for a file
 * const recommendation = getLSPRecommendation('/path/to/file.ts', servers);
 *
 * // Connect to a language server
 * const client = await lspClientManager.connect(
 *   available[0],
 *   'file:///path/to/project',
 * );
 * ```
 *
 * @module ide
 */

// IDE Detection
export {
  detectIDEs,
  discoverLanguageServers,
  getLSPRecommendation,
  isExtensionInstalled,
} from './discovery.js';

// IDE Extension Installation
export {
  checkExtensionStatus,
  installExtension,
  checkAllExtensions,
  installAllExtensions,
  getInstallationSummary,
} from './installer.js';

// LSP Client Management
export { LSPClient, LSPClientManager, lspClientManager } from './lsp-client.js';

// Types
export type {
  IDEId,
  IDECategory,
  DetectedIDE,
  IDEScanResult,
  ExtensionStatus,
  ExtensionId,
  ExtensionResult,
  IDEInstallConfig,
  DiscoveredLSP,
  LSPProjectConfig,
  LSPRecommendation,
  LSPConnectionState,
  LSPClientConfig,
  LSPConnectionStatus,
  LSPDiagnostic,
  IDEManagerConfig,
  LSPServerRegistry,
  IDEEvent,
  IDEEventHandler,
} from './types.js';

export {
  SUDO_VSCODE_EXTENSION,
  DEFAULT_IDE_INSTALL_CONFIG,
  DEFAULT_IDE_MANAGER_CONFIG,
  KNOWN_LSP_SERVERS,
} from './types.js';

// IDE Bridge (IDE extension protocol)
export { IdeBridgeAdapter } from './bridge-adapter.js';
export { BridgeDiscovery, writePortFile, readPortFile, deletePortFile, isStalePid } from './bridge-discovery.js';
export {
  issueSessionJwt,
  validateSessionJwt,
  verifyGatewayToken,
  getServerEpoch,
  resetServerEpoch,
} from './bridge-auth.js';
export {
  createConnection,
  transitionPhase,
  initializeConnection,
  isHeartbeatTimedOut,
  recordHeartbeat,
  startHeartbeatMonitor,
  createAbortController,
  abortCurrentOperation,
  addPendingApproval,
  resolvePendingApproval,
  rejectAllPendingApprovals,
  cleanupConnection,
} from './bridge-session.js';
export { buildBridgeRouter, dispatchMessage } from './bridge-protocol.js';

// IDE Bridge types
export type {
  BridgeConnection,
  PendingToolApproval,
  BridgeConfig,
  BridgeRouterDeps,
  BridgeMethodResult,
  BridgeMethodContext,
  BridgeMethodHandler,
  SessionManagerLike,
  AgentLoopLike,
  AgentEventLike,
  AgentRunResultLike,
  ProgressBroadcasterLike,
  ProgressEventLike,
  HookManagerLike,
} from './bridge-types.js';
export { DEFAULT_BRIDGE_CONFIG } from './bridge-types.js';

// ---------------------------------------------------------------------------
// IDE Manager (facade)
// ---------------------------------------------------------------------------

import { createLogger } from '../shared/logger.js';
import { detectIDEs, discoverLanguageServers, getLSPRecommendation } from './discovery.js';
import { installExtension, installAllExtensions, getInstallationSummary } from './installer.js';
import type {
  DetectedIDE,
  DiscoveredLSP,
  ExtensionId,
  ExtensionResult,
  IDEInstallConfig,
  IDEManagerConfig,
  IDEScanResult,
  LSPRecommendation,
  IDEEvent,
  IDEEventHandler,
} from './types.js';
import { DEFAULT_IDE_MANAGER_CONFIG } from './types.js';

const log = createLogger('ide:manager');

/**
 * IDEManager — high-level facade for all IDE operations.
 *
 * Provides a unified API for IDE detection, extension management,
 * LSP discovery, and LSP connections. Wraps the lower-level
 * discovery, installer, and LSP client modules.
 */
export class IDEManager {
  private config: IDEManagerConfig;
  private cachedScan: IDEScanResult | null = null;
  private cachedLSP: DiscoveredLSP[] | null = null;
  private cachedScanTime = 0;
  private cachedLSPTime = 0;
  private eventHandlers = new Map<string, Set<IDEEventHandler>>();

  constructor(config?: Partial<IDEManagerConfig>) {
    this.config = {
      ...DEFAULT_IDE_MANAGER_CONFIG,
      ...config,
      install: { ...DEFAULT_IDE_MANAGER_CONFIG.install, ...config?.install },
    };
  }

  // -------------------------------------------------------------------------
  // IDE Detection
  // -------------------------------------------------------------------------

  /**
   * Scan for installed/running IDEs.
   * Uses cache if available and not expired.
   */
  scanIDEs(force = false): IDEScanResult {
    const now = Date.now();
    const cacheAge = (now - this.cachedScanTime) / 1000;

    if (!force && this.cachedScan && cacheAge < this.config.cacheTTLSecs) {
      log.debug({ cacheAge: Math.round(cacheAge) }, 'Returning cached IDE scan');
      return this.cachedScan;
    }

    const result = detectIDEs(this.config);
    this.cachedScan = result;
    this.cachedScanTime = now;

    // Emit events for detected IDEs
    for (const ide of result.ides) {
      this.emit({ type: 'ide_detected', ide });
    }

    return result;
  }

  /**
   * Get detected IDEs (shortcut for scanIDEs().ides).
   */
  getIDEs(force = false): DetectedIDE[] {
    return this.scanIDEs(force).ides;
  }

  // -------------------------------------------------------------------------
  // LSP Discovery
  // -------------------------------------------------------------------------

  /**
   * Discover available language servers.
   * Uses cache if available and not expired.
   */
  discoverLSPs(force = false): DiscoveredLSP[] {
    const now = Date.now();
    const cacheAge = (now - this.cachedLSPTime) / 1000;

    if (!force && this.cachedLSP && cacheAge < this.config.cacheTTLSecs) {
      log.debug({ cacheAge: Math.round(cacheAge) }, 'Returning cached LSP discovery');
      return this.cachedLSP;
    }

    const servers = discoverLanguageServers(this.config);
    this.cachedLSP = servers;
    this.cachedLSPTime = now;

    // Emit events for discovered servers
    for (const lsp of servers) {
      if (lsp.available) {
        this.emit({ type: 'lsp_discovered', lsp });
      }
    }

    return servers;
  }

  /**
   * Get available LSP servers (shortcut for discoverLSPs().filter(s => s.available)).
   */
  getAvailableLSPs(force = false): DiscoveredLSP[] {
    return this.discoverLSPs(force).filter((s) => s.available);
  }

  /**
   * Get LSP recommendation for a file.
   */
  getLSPForFile(filePath: string): LSPRecommendation | null {
    const servers = this.discoverLSPs();
    const recommended = getLSPRecommendation(filePath, servers);

    if (recommended) {
      this.emit({
        type: 'lsp_recommendation',
        recommendation: {
          filePath,
          language: recommended.language,
          recommendedServer: recommended,
          alternatives: servers.filter(
            (s) =>
              s.available &&
              s.id !== recommended.id &&
              s.fileExtensions.some((ext) =>
                recommended.fileExtensions.includes(ext),
              ),
          ),
          isInstalled: recommended.available,
          confidence: recommended.available ? 0.9 : 0.5,
        },
      });
    }

    return recommended
      ? {
          filePath,
          language: recommended.language,
          recommendedServer: recommended,
          alternatives: servers.filter(
            (s) =>
              s.available &&
              s.id !== recommended.id &&
              s.fileExtensions.some((ext) =>
                recommended.fileExtensions.includes(ext),
              ),
          ),
          isInstalled: recommended.available,
          confidence: recommended.available ? 0.9 : 0.5,
        }
      : null;
  }

  // -------------------------------------------------------------------------
  // Extension Management
  // -------------------------------------------------------------------------

  /**
   * Install extensions for all detected IDEs.
   */
  installExtensions(
    extensions?: ExtensionId[],
    force = false,
  ): ExtensionResult[] {
    const ides = this.scanIDEs(force).ides;
    const exts = extensions ?? this.config.install.extensions;
    const results = installAllExtensions(ides, exts, this.config.install);

    // Emit events
    for (const result of results) {
      if (result.installSucceeded) {
        this.emit({
          type: 'extension_installed',
          extension: result.extension,
          ide: ides.find((ide) =>
            result.extension.targetIDEs.includes(ide.id),
          )!.id,
        });
      } else if (result.installAttempted && !result.installSucceeded) {
        this.emit({
          type: 'extension_install_failed',
          extension: result.extension,
          ide: ides.find((ide) =>
            result.extension.targetIDEs.includes(ide.id),
          )!.id,
          error: result.error ?? 'Unknown error',
        });
      }
    }

    return results;
  }

  /**
   * Get a summary of extension installation status.
   */
  getExtensionStatus(
    extensions?: ExtensionId[],
    force = false,
  ) {
    const ides = this.scanIDEs(force).ides;
    const exts = extensions ?? this.config.install.extensions;
    return getInstallationSummary(ides, exts);
  }

  // -------------------------------------------------------------------------
  // Event System
  // -------------------------------------------------------------------------

  /**
   * Register an event handler.
   */
  on(handler: IDEEventHandler): void {
    // Use a generic event type since we handle all events with one handler
    if (!this.eventHandlers.has('all')) {
      this.eventHandlers.set('all', new Set());
    }
    this.eventHandlers.get('all')!.add(handler);
  }

  /**
   * Remove an event handler.
   */
  off(handler: IDEEventHandler): void {
    this.eventHandlers.get('all')?.delete(handler);
  }

  private emit(event: IDEEvent): void {
    this.eventHandlers.get('all')?.forEach((handler) => {
      try {
        handler(event);
      } catch (err) {
        log.error({ err: String(err) }, 'IDE manager event handler error');
      }
    });
  }

  // -------------------------------------------------------------------------
  // Convenience
  // -------------------------------------------------------------------------

  /**
   * Get a human-readable summary of the IDE environment.
   */
  getSummary(): string {
    const ides = this.scanIDEs();
    const lsps = this.discoverLSPs();
    const availableLSPs = lsps.filter((s) => s.available);

    const lines: string[] = [
      `IDE Environment Summary`,
      `========================`,
      `Platform: ${ides.platform}`,
      `Scan time: ${ides.scanDurationMs}ms`,
      ``,
      `Detected IDEs (${ides.ides.length}):`,
    ];

    if (ides.ides.length === 0) {
      lines.push('  (none detected)');
    } else {
      for (const ide of ides.ides) {
        const running = ide.isRunning ? '● Running' : '○ Installed';
        const version = ide.version ? ` v${ide.version}` : '';
        lines.push(`  ${running} ${ide.name}${version}`);
      }
    }

    lines.push('', `Language Servers (${availableLSPs.length}/${lsps.length} available):`);

    if (availableLSPs.length === 0) {
      lines.push('  (none available)');
    } else {
      for (const lsp of availableLSPs) {
        const version = lsp.version ? ` (${lsp.version})` : '';
        lines.push(`  ✓ ${lsp.name}${version}`);
      }
    }

    return lines.join('\n');
  }
}

/** Singleton IDE manager instance. */
export const ideManager = new IDEManager();
/**
 * Superpowers toolkit — registers all 12 superpower tools into the ToolRegistry.
 *
 * Each tool is defined in src/core/superpowers/ and already implements
 * ToolDefinition fully. This file is the discovery bridge that the built-in
 * tool loader finds automatically via the `builtin/` directory scan.
 *
 * Tools registered:
 *   super.auto-fix          — Error detection and root cause diagnosis
 *   super.deploy            — One-command deployment (git/docker/pm2/rsync)
 *   super.security-scan     — Vulnerability scanning (code/deps/network)
 *   super.profile           — Performance profiling (commands and URLs)
 *   super.analyze-data      — CSV/JSON data analysis with stats and queries
 *   super.build-api         — REST API scaffold generator
 *   super.build-scraper     — Playwright web scraper generator
 *   super.generate-pdf      — Markdown/HTML to PDF via Playwright
 *   super.edit-image        — Image manipulation via sharp
 *   super.ffmpeg            — Video/audio manipulation via ffmpeg
 *   super.archive           — Compress/extract/list archives
 *   super.translate         — Multi-language translation via LLM brain
 */

import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';
import { gateSuperpowers } from '../../../superpowers/gating.js';

import { autoFixTool }             from '../../../superpowers/auto-fix.js';
import { deployTool }              from '../../../superpowers/deploy.js';
import { securityScanTool }        from '../../../superpowers/security-scan.js';
import { performanceProfilerTool } from '../../../superpowers/performance-profiler.js';
import { dataAnalyzerTool }        from '../../../superpowers/data-analyzer.js';
import { apiBuilderTool }          from '../../../superpowers/api-builder.js';
import { scraperBuilderTool }      from '../../../superpowers/scraper-builder.js';
import { pdfGeneratorTool }        from '../../../superpowers/pdf-generator.js';
import { ffmpegTool }              from '../../../superpowers/ffmpeg-tools.js';
import { archiveManagerTool }      from '../../../superpowers/archive-manager.js';
import { translateTool }           from '../../../superpowers/translate.js';

const logger = createLogger('superpowers-builtin');

/** All 11 superpower tools in stable registration order. */
const SUPERPOWER_TOOLS = [
  autoFixTool,
  deployTool,
  securityScanTool,
  performanceProfilerTool,
  dataAnalyzerTool,
  apiBuilderTool,
  scraperBuilderTool,
  pdfGeneratorTool,
  ffmpegTool,
  archiveManagerTool,
  translateTool,
] as const;

/**
 * Register all superpower tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerSuperpowersTools(registry: ToolRegistry): void {
  // F108: per-tool gating (see superpowers/gating.ts).
  const { enabled, denied, allowlistMode } = gateSuperpowers(SUPERPOWER_TOOLS);
  logger.info({ count: enabled.length, denied: denied.length, allowlistMode }, 'Registering superpower tools');
  for (const tool of enabled) {
    registry.register(tool);
  }
  if (denied.length > 0) {
    logger.warn({ denied }, 'Superpower tools withheld by gating');
  }
  logger.info({ count: enabled.length }, 'Superpower tools registered');
}

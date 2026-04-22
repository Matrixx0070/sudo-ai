/**
 * Superpowers module barrel — registers all 12 superpower tools.
 *
 * Call `registerSuperpowers(registry)` from the application bootstrap
 * to make all super.* tools available to the agent.
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

import type { ToolRegistry } from '../tools/registry.js';
import { createLogger } from '../shared/logger.js';

import { autoFixTool }             from './auto-fix.js';
import { deployTool }              from './deploy.js';
import { securityScanTool }        from './security-scan.js';
import { performanceProfilerTool } from './performance-profiler.js';
import { dataAnalyzerTool }        from './data-analyzer.js';
import { apiBuilderTool }          from './api-builder.js';
import { scraperBuilderTool }      from './scraper-builder.js';
import { pdfGeneratorTool }        from './pdf-generator.js';
import { imageEditorTool }         from './image-editor.js';
import { ffmpegTool }              from './ffmpeg-tools.js';
import { archiveManagerTool }      from './archive-manager.js';
import { translateTool }           from './translate.js';

const logger = createLogger('superpowers-index');

/** All superpower tools in a stable order. */
const SUPERPOWER_TOOLS = [
  autoFixTool,
  deployTool,
  securityScanTool,
  performanceProfilerTool,
  dataAnalyzerTool,
  apiBuilderTool,
  scraperBuilderTool,
  pdfGeneratorTool,
  imageEditorTool,
  ffmpegTool,
  archiveManagerTool,
  translateTool,
] as const;

/**
 * Register all superpower tools with the given registry.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerSuperpowers(registry: ToolRegistry): void {
  logger.info({ count: SUPERPOWER_TOOLS.length }, 'Registering superpower tools');
  for (const tool of SUPERPOWER_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: SUPERPOWER_TOOLS.length }, 'Superpower tools registered');
}

// Named re-exports for consumers that import individual tools.
export {
  autoFixTool,
  deployTool,
  securityScanTool,
  performanceProfilerTool,
  dataAnalyzerTool,
  apiBuilderTool,
  scraperBuilderTool,
  pdfGeneratorTool,
  imageEditorTool,
  ffmpegTool,
  archiveManagerTool,
  translateTool,
};

/**
 * Media toolkit — registers 7 media production tools into the ToolRegistry.
 *
 * Tools registered:
 *   media.image-generate      — Multi-provider image gen (DALL-E, Stable Diffusion, Flux)
 *   media.image-edit-advanced — Remove bg, upscale, inpaint, outpaint (wraps super.edit-image)
 *   media.thumbnail-generate  — YouTube/social thumbnails with text overlay
 *   media.video-edit          — Cut, trim, merge, transitions, text overlay (wraps super.ffmpeg)
 *   media.video-generate      — Text/image to video via AI APIs (Luma, RunwayML, Kling)
 *   media.shorts-factory      — Auto-produce vertical short-form videos
 *   media.video-to-clips      — Auto-detect highlights, cut long video into clips
 *
 * Module layout:
 *   helpers.ts        — Shared utilities (runFfmpeg, ensureDir, missingKey, escapeXml)
 *   image-tools.ts    — media.image-generate, media.image-edit-advanced
 *   thumbnail-tool.ts — media.thumbnail-generate
 *   video-tools.ts    — media.video-edit, media.video-generate, media.video-to-clips
 *   factory-tools.ts  — media.shorts-factory
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

import { imageGenerateTool, imageEditAdvancedTool } from './image-tools.js';
import { thumbnailGenerateTool } from './thumbnail-tool.js';
import { videoEditTool, videoGenerateTool, videoToClipsTool } from './video-tools.js';
import { shortsFactoryTool } from './factory-tools.js';
import { chartTool } from './tools/chart.js';
import { qrTool } from './tools/qr.js';

const logger = createLogger('media-builtin');

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

const MEDIA_TOOLS: ToolDefinition[] = [
  imageGenerateTool,
  imageEditAdvancedTool,
  thumbnailGenerateTool,
  videoEditTool,
  videoGenerateTool,
  shortsFactoryTool,
  videoToClipsTool,
  chartTool,
  qrTool,
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all media tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerMediaTools(registry: ToolRegistry): void {
  logger.info({ count: MEDIA_TOOLS.length }, 'Registering media tools');
  for (const tool of MEDIA_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: MEDIA_TOOLS.length }, 'Media tools registered');
}

/**
 * Media thumbnail tool: media.thumbnail-generate.
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { ensureDir, escapeXml, runFfmpegSilent } from './helpers.js';

const logger = createLogger('media-thumbnail');

// ---------------------------------------------------------------------------
// media.thumbnail-generate
// ---------------------------------------------------------------------------

export const thumbnailGenerateTool: ToolDefinition = {
  name: 'media.thumbnail-generate',
  description: 'Generate YouTube/social thumbnails (1280x720 JPEG). Extracts a frame from video or uses a source image, then overlays title and subtitle text using sharp SVG composite.',
  category: 'media',
  timeout: 60_000,
  parameters: {
    source: { type: 'string', required: true, description: 'Absolute path to source video or image.' },
    outputPath: { type: 'string', required: true, description: 'Absolute path for the output JPEG thumbnail.' },
    titleText: { type: 'string', description: 'Main title text to overlay.' },
    subtitleText: { type: 'string', description: 'Subtitle text below the title.' },
    frameTime: { type: 'string', description: 'Timestamp HH:MM:SS to extract from video (default: 00:00:05).', default: '00:00:05' },
    textColor: { type: 'string', description: 'Text color CSS hex (default: #FFFFFF).', default: '#FFFFFF' },
    fontSize: { type: 'number', description: 'Font size px (default: 72).', default: 72 },
    isVideo: { type: 'boolean', description: 'True if source is a video file (default: false).', default: false },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const source = params['source'] as string | undefined;
    const outputPath = params['outputPath'] as string | undefined;
    const titleText = params['titleText'] as string | undefined;
    const subtitleText = params['subtitleText'] as string | undefined;
    const frameTime = (params['frameTime'] as string | undefined) ?? '00:00:05';
    const textColor = (params['textColor'] as string | undefined) ?? '#FFFFFF';
    const fontSize = (params['fontSize'] as number | undefined) ?? 72;
    const isVideo = (params['isVideo'] as boolean | undefined) ?? false;

    if (!source?.trim()) return { success: false, output: 'source is required.' };
    if (!outputPath?.trim()) return { success: false, output: 'outputPath is required.' };

    logger.info({ session: ctx.sessionId, source, isVideo }, 'media.thumbnail-generate invoked');

    try {
      const sharp = await import('sharp').catch(() => {
        throw new Error('sharp is not installed. Run: npm install sharp');
      });

      ensureDir(path.dirname(outputPath));

      // Extract frame from video if needed
      let imageSource = source;
      if (isVideo) {
        const framePath = outputPath + '.frame.png';
        await runFfmpegSilent(['-ss', frameTime, '-i', source, '-frames:v', '1', '-q:v', '2', framePath], ctx.signal);
        imageSource = framePath;
      }

      // Resize to 1280x720
      let pipeline = sharp.default(imageSource).resize({ width: 1280, height: 720, fit: 'cover' });

      // Build SVG text overlay
      if (titleText || subtitleText) {
        const svgLines: string[] = [];
        if (titleText) {
          svgLines.push(
            `<text x="64" y="${720 - 160}" font-family="Arial,sans-serif" ` +
            `font-size="${fontSize}" font-weight="bold" fill="${textColor}" ` +
            `stroke="#000000" stroke-width="3">${escapeXml(titleText)}</text>`,
          );
        }
        if (subtitleText) {
          const subSize = Math.round(fontSize * 0.55);
          svgLines.push(
            `<text x="64" y="${720 - 80}" font-family="Arial,sans-serif" ` +
            `font-size="${subSize}" fill="${textColor}" ` +
            `stroke="#000000" stroke-width="2">${escapeXml(subtitleText)}</text>`,
          );
        }
        const svg = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">${svgLines.join('')}</svg>`,
        );
        pipeline = pipeline.composite([{ input: svg, blend: 'over' }]);
      }

      await pipeline.jpeg({ quality: 92 }).toFile(outputPath);
      logger.info({ outputPath }, 'Thumbnail generated');

      const artifacts: ToolArtifact[] = [{ path: outputPath, action: 'created' }];
      return {
        success: true,
        output: `Thumbnail saved to: ${outputPath}`,
        data: { outputPath, size: '1280x720' },
        artifacts,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ source, err: msg }, 'media.thumbnail-generate failed');
      return { success: false, output: `Thumbnail generation failed: ${msg}` };
    }
  },
};

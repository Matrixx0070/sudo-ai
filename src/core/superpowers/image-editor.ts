/**
 * super.edit-image — Image manipulation using sharp.
 *
 * Supports: resize, crop, rotate, watermark (composite), format conversion.
 * Operations are applied sequentially in the order provided.
 */

import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../tools/types.js';

const logger = createLogger('super.edit-image');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResizeOp  { type: 'resize';    width?: number; height?: number; fit?: string }
interface CropOp    { type: 'crop';      left: number; top: number; width: number; height: number }
interface RotateOp  { type: 'rotate';    angle: number }
interface WatermarkOp { type: 'watermark'; text?: string; imagePath?: string; gravity?: string }
interface ConvertOp { type: 'convert';   format: string; quality?: number }

type ImageOperation = ResizeOp | CropOp | RotateOp | WatermarkOp | ConvertOp;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateOperation(op: Record<string, unknown>): op is Record<string, unknown> & { type: string } {
  return typeof op['type'] === 'string';
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const imageEditorTool: ToolDefinition = {
  name: 'super.edit-image',
  description: 'Image manipulation with sharp: resize, crop, rotate, watermark, and format conversion.',
  category: 'superpowers',
  timeout: 60_000,
  parameters: {
    input: { type: 'string', description: 'Absolute path to source image.', required: true },
    operations: {
      type: 'array',
      description: 'Ordered list of operations to apply.',
      required: true,
      items: {
        type: 'object',
        description: 'Operation descriptor with type and parameters.',
        properties: {
          type: { type: 'string', description: 'Operation type: resize | crop | rotate | watermark | convert', enum: ['resize', 'crop', 'rotate', 'watermark', 'convert'] },
          width: { type: 'number', description: 'Width in pixels (resize).' },
          height: { type: 'number', description: 'Height in pixels (resize).' },
          fit: { type: 'string', description: 'Fit mode for resize: cover | contain | fill | inside | outside.' },
          left: { type: 'number', description: 'Crop left offset.' },
          top: { type: 'number', description: 'Crop top offset.' },
          angle: { type: 'number', description: 'Rotation angle in degrees.' },
          text: { type: 'string', description: 'Watermark text.' },
          imagePath: { type: 'string', description: 'Watermark overlay image path.' },
          gravity: { type: 'string', description: 'Watermark position: center | north | south | east | west.' },
          format: { type: 'string', description: 'Output format: jpeg | png | webp | avif | gif.' },
          quality: { type: 'number', description: 'Output quality 1-100 (jpeg/webp/avif).' },
        },
      },
    },
    output: { type: 'string', description: 'Absolute path for the output image.', required: true },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const input = params['input'] as string | undefined;
    const output = params['output'] as string | undefined;
    const rawOps = params['operations'] as unknown[] | undefined;

    if (!input) return { success: false, output: 'input is required.' };
    if (!output) return { success: false, output: 'output is required.' };
    if (!Array.isArray(rawOps) || rawOps.length === 0) return { success: false, output: 'operations must be a non-empty array.' };

    const ops = rawOps.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null);
    const validOps = ops.filter(validateOperation) as ImageOperation[];

    if (validOps.length === 0) return { success: false, output: 'No valid operations found.' };

    logger.info({ session: ctx.sessionId, input, output, opCount: validOps.length }, 'Image edit started');

    try {
      const sharp = await import('sharp').catch(() => {
        throw new Error('sharp is not installed. Run: npm install sharp');
      });

      let pipeline = sharp.default(input);

      for (const op of validOps) {
        switch (op.type) {
          case 'resize': {
            const r = op as ResizeOp;
            pipeline = pipeline.resize({
              width: r.width,
              height: r.height,
              fit: (r.fit as 'cover' | 'contain' | 'fill' | 'inside' | 'outside') ?? 'cover',
            });
            break;
          }

          case 'crop': {
            const c = op as CropOp;
            pipeline = pipeline.extract({ left: c.left, top: c.top, width: c.width, height: c.height });
            break;
          }

          case 'rotate': {
            const r = op as RotateOp;
            pipeline = pipeline.rotate(r.angle);
            break;
          }

          case 'watermark': {
            const w = op as WatermarkOp;
            if (w.imagePath) {
              pipeline = pipeline.composite([{ input: w.imagePath, gravity: (w.gravity ?? 'center') as 'center' }]);
            } else if (w.text) {
              // SVG text overlay — escape XML-special characters so text
              // containing &, <, >, or " produces valid SVG markup.
              const escaped = w.text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
              const svg = Buffer.from(
                `<svg><text x="10" y="30" font-size="24" fill="white" opacity="0.7">${escaped}</text></svg>`,
              );
              pipeline = pipeline.composite([{ input: svg, gravity: (w.gravity ?? 'south') as 'center' }]);
            }
            break;
          }

          case 'convert': {
            const c = op as ConvertOp;
            const fmt = c.format as 'jpeg' | 'png' | 'webp' | 'avif' | 'gif';
            pipeline = pipeline.toFormat(fmt, c.quality ? { quality: c.quality } : {});
            break;
          }
        }
      }

      await pipeline.toFile(output);
      logger.info({ output }, 'Image edit complete');

      const artifacts: ToolArtifact[] = [{ path: output, action: 'created' }];

      return {
        success: true,
        output: `Image processed with ${validOps.length} operation(s). Saved to: ${output}`,
        data: { input, output, operations: validOps.map((o) => o.type) },
        artifacts,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ input, output, err: msg }, 'Image edit failed');
      return { success: false, output: `Image edit failed: ${msg}` };
    }
  },
};

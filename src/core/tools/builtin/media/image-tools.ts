/**
 * Media image tools: media.image-generate, media.image-edit-advanced.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { ensureDir, missingKey } from './helpers.js';

const logger = createLogger('media-image');

// ---------------------------------------------------------------------------
// media.image-generate
// ---------------------------------------------------------------------------

export const imageGenerateTool: ToolDefinition = {
  name: 'media.image-generate',
  description: 'Generate images via AI providers: DALL-E 3 (OpenAI), Stable Diffusion (Stability AI), Flux (Black Forest Labs). Saves to disk and returns file path.',
  category: 'media',
  timeout: 120_000,
  parameters: {
    prompt: { type: 'string', required: true, description: 'Text description of the image to generate.' },
    outputPath: { type: 'string', required: true, description: 'Absolute path to save the generated image.' },
    provider: { type: 'string', description: 'AI provider (default: dalle).', enum: ['dalle', 'stable-diffusion', 'flux'], default: 'dalle' },
    size: { type: 'string', description: 'Image dimensions (default: 1024x1024).', enum: ['512x512', '1024x1024', '1024x1792', '1792x1024'], default: '1024x1024' },
    quality: { type: 'string', description: 'Quality for DALL-E (default: standard).', enum: ['standard', 'hd'], default: 'standard' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = params['prompt'] as string | undefined;
    const outputPath = params['outputPath'] as string | undefined;
    const provider = (params['provider'] as string | undefined) ?? 'dalle';
    const size = (params['size'] as string | undefined) ?? '1024x1024';
    const quality = (params['quality'] as string | undefined) ?? 'standard';

    if (!prompt?.trim()) return { success: false, output: 'prompt is required.' };
    if (!outputPath?.trim()) return { success: false, output: 'outputPath is required.' };

    logger.info({ session: ctx.sessionId, provider, size }, 'media.image-generate invoked');

    try {
      let imageBuffer: Buffer;

      if (provider === 'dalle') {
        const apiKey = process.env['OPENAI_API_KEY'];
        if (!apiKey) return missingKey('OPENAI_API_KEY', 'media.image-generate');
        const res = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size, quality, response_format: 'b64_json' }),
        });
        if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = await res.json() as { data: Array<{ b64_json?: string }> };
        const b64 = json.data[0]?.b64_json;
        if (!b64) throw new Error('DALL-E returned no image data.');
        imageBuffer = Buffer.from(b64, 'base64');

      } else if (provider === 'stable-diffusion') {
        const apiKey = process.env['STABILITY_API_KEY'];
        if (!apiKey) return missingKey('STABILITY_API_KEY', 'media.image-generate');
        const [w, h] = size.split('x').map(Number);
        const res = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify({ text_prompts: [{ text: prompt, weight: 1 }], width: w ?? 1024, height: h ?? 1024, samples: 1 }),
        });
        if (!res.ok) throw new Error(`Stability AI error ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = await res.json() as { artifacts: Array<{ base64: string }> };
        const b64 = json.artifacts[0]?.base64;
        if (!b64) throw new Error('Stability AI returned no image data.');
        imageBuffer = Buffer.from(b64, 'base64');

      } else if (provider === 'flux') {
        const apiKey = process.env['FLUX_API_KEY'];
        if (!apiKey) return missingKey('FLUX_API_KEY', 'media.image-generate');
        const genRes = await fetch('https://api.bfl.ml/v1/flux-pro-1.1', {
          method: 'POST',
          headers: { 'x-key': apiKey, 'Content-Type': 'application/json' },
          signal: ctx.signal,
          body: JSON.stringify({ prompt, width: 1024, height: 1024 }),
        });
        if (!genRes.ok) throw new Error(`Flux API error ${genRes.status}: ${(await genRes.text()).slice(0, 200)}`);
        const json = await genRes.json() as { sample?: string };
        if (!json.sample) throw new Error('Flux API returned no image URL.');
        const imgRes = await fetch(json.sample, { signal: ctx.signal });
        imageBuffer = Buffer.from(await imgRes.arrayBuffer());

      } else {
        return { success: false, output: `Unknown provider: ${provider}` };
      }

      ensureDir(path.dirname(outputPath));
      writeFileSync(outputPath, imageBuffer);
      logger.info({ outputPath, provider }, 'Image generated and saved');
      const artifacts: ToolArtifact[] = [{ path: outputPath, action: 'created', size: imageBuffer.length }];
      return { success: true, output: `Image generated with ${provider}. Saved to: ${outputPath}`, data: { provider, size, outputPath }, artifacts };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ provider, err: msg }, 'media.image-generate failed');
      return { success: false, output: `Image generation failed: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// media.image-edit-advanced
// ---------------------------------------------------------------------------

export const imageEditAdvancedTool: ToolDefinition = {
  name: 'media.image-edit-advanced',
  description: 'Advanced image editing: remove background (remove.bg API), upscale, inpaint, plus resize/crop/rotate/watermark/convert via sharp (super.edit-image engine).',
  category: 'media',
  timeout: 120_000,
  parameters: {
    input: { type: 'string', required: true, description: 'Absolute path to source image.' },
    output: { type: 'string', required: true, description: 'Absolute path for output image.' },
    operations: {
      type: 'array', required: true,
      description: 'Ordered operations: resize | crop | rotate | watermark | convert | remove-bg | upscale | inpaint',
      items: {
        type: 'object', description: 'Operation descriptor.',
        properties: {
          type: { type: 'string', description: 'Operation type.', enum: ['resize', 'crop', 'rotate', 'watermark', 'convert', 'remove-bg', 'upscale', 'inpaint'] },
          width: { type: 'number', description: 'Width in pixels.' },
          height: { type: 'number', description: 'Height in pixels.' },
          fit: { type: 'string', description: 'Fit mode: cover | contain | fill | inside | outside.' },
          left: { type: 'number', description: 'Crop left offset.' },
          top: { type: 'number', description: 'Crop top offset.' },
          angle: { type: 'number', description: 'Rotation degrees.' },
          text: { type: 'string', description: 'Watermark text.' },
          imagePath: { type: 'string', description: 'Watermark overlay path.' },
          gravity: { type: 'string', description: 'Position: center | north | south | east | west.' },
          format: { type: 'string', description: 'Output format: jpeg | png | webp | avif | gif.' },
          quality: { type: 'number', description: 'Quality 1-100.' },
          scale: { type: 'number', description: 'Upscale factor (2 or 4).' },
          maskPath: { type: 'string', description: 'Mask path for inpaint.' },
          fillColor: { type: 'string', description: 'Fill color for inpaint.' },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const input = params['input'] as string | undefined;
    const output = params['output'] as string | undefined;
    const rawOps = params['operations'] as unknown[] | undefined;

    if (!input?.trim()) return { success: false, output: 'input is required.' };
    if (!output?.trim()) return { success: false, output: 'output is required.' };
    if (!Array.isArray(rawOps) || rawOps.length === 0) return { success: false, output: 'operations must be a non-empty array.' };

    logger.info({ session: ctx.sessionId, input, opCount: rawOps.length }, 'media.image-edit-advanced invoked');

    const ops = rawOps.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null);
    const advancedTypes = new Set(['remove-bg', 'upscale', 'inpaint']);
    const sharpOps = ops.filter((o) => !advancedTypes.has(String(o['type'])));
    const specialOps = ops.filter((o) => advancedTypes.has(String(o['type'])));

    try {
      // @ts-expect-error sharp optional dep
      const sharp = await import('sharp').catch(() => { throw new Error('sharp is not installed. Run: npm install sharp'); });
      let currentInput = input;

      for (const op of specialOps) {
        const opType = String(op['type']);
        if (opType === 'remove-bg') {
          const apiKey = process.env['REMOVE_BG_API_KEY'];
          if (!apiKey) return missingKey('REMOVE_BG_API_KEY', 'media.image-edit-advanced (remove-bg)');
          const { readFileSync } = await import('node:fs');
          const formData = new FormData();
          formData.append('image_file', new Blob([readFileSync(currentInput)]), path.basename(currentInput));
          formData.append('size', 'auto');
          const res = await fetch('https://api.remove.bg/v1.0/removebg', { method: 'POST', headers: { 'X-Api-Key': apiKey }, body: formData, signal: ctx.signal });
          if (!res.ok) throw new Error(`remove.bg API error ${res.status}`);
          const tmpPath = output + '.nobg.png';
          writeFileSync(tmpPath, Buffer.from(await res.arrayBuffer()));
          currentInput = tmpPath;

        } else if (opType === 'upscale') {
          const scale = Number(op['scale'] ?? 2);
          const meta = await sharp.default(currentInput).metadata();
          const tmpPath = output + '.upscaled.png';
          await sharp.default(currentInput).resize({ width: (meta.width ?? 1024) * scale, height: (meta.height ?? 1024) * scale, fit: 'fill' }).toFile(tmpPath);
          currentInput = tmpPath;

        } else if (opType === 'inpaint') {
          const maskPath = op['maskPath'] as string | undefined;
          const fillColor = (op['fillColor'] as string | undefined) ?? '#000000';
          if (!maskPath) return { success: false, output: 'maskPath is required for inpaint.' };
          const meta = await sharp.default(currentInput).metadata();
          const [w, h] = [meta.width ?? 512, meta.height ?? 512];
          const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fillColor}"/></svg>`);
          const tmpPath = output + '.inpainted.png';
          await sharp.default(currentInput).composite([{ input: svg, blend: 'dest-in' }, { input: maskPath, blend: 'over' }]).toFile(tmpPath);
          currentInput = tmpPath;
        }
      }

      if (sharpOps.length > 0) {
        const { imageEditorTool } = await import('../../../superpowers/image-editor.js');
        return imageEditorTool.execute({ input: currentInput, output, operations: sharpOps }, ctx);
      }

      if (currentInput !== input) {
        const { copyFileSync } = await import('node:fs');
        copyFileSync(currentInput, output);
      }

      const artifacts: ToolArtifact[] = [{ path: output, action: 'created' }];
      return { success: true, output: `Image editing complete. Saved to: ${output}`, data: { input, output, opCount: ops.length }, artifacts };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ input, err: msg }, 'media.image-edit-advanced failed');
      return { success: false, output: `Image edit failed: ${msg}` };
    }
  },
};

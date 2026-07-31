/**
 * @file create.ts
 * @description pptx.create — Creates a real .pptx PowerPoint deck with pptxgenjs.
 *
 * Complements document.slides (which rasterises a deck to PDF): this produces a
 * genuine editable PowerPoint file. Chosen over the Claude seat's hosted "skills"
 * container because that container has no retrievable file output on a Max seat
 * (Files API 404s) and is rate-limited — local generation is offline, instant,
 * unbounded in size and costs no tokens.
 */

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('pptx:create');

const ALLOWED_DIRS = ['/tmp', dataPath('pptx')];

/** Slide dimensions/layout: 16:9 widescreen (inches). */
const LAYOUT = { name: 'SUDO_16x9', width: 13.333, height: 7.5 };

function isAllowedPath(outputPath: string): boolean {
  const resolved = path.resolve(outputPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

interface SlideDef {
  title?: string;
  bullets?: string[];
  notes?: string;
}

export const pptxCreateTool: ToolDefinition = {
  name: 'pptx.create',
  description:
    'Create a real .pptx PowerPoint presentation (editable in PowerPoint/Keynote/Google Slides). ' +
    'Takes a title slide plus content slides with bullet points and optional speaker notes. ' +
    'Use this when the user wants an actual PowerPoint file; use document.slides when a PDF deck is fine. ' +
    'Output must be under /tmp/ or data/pptx/.',
  category: 'content',
  timeout: 30_000,
  parameters: {
    outputPath: {
      type: 'string',
      required: true,
      description: `Absolute output path ending in .pptx. Must be under /tmp/ or ${PROJECT_ROOT}/data/pptx/.`,
    },
    title: {
      type: 'string',
      required: true,
      description: 'Deck title, shown large on the opening title slide.',
    },
    subtitle: {
      type: 'string',
      required: false,
      description: 'Optional subtitle/byline under the title on the opening slide.',
    },
    slides: {
      type: 'array',
      required: true,
      description: 'Content slides that follow the title slide.',
      items: {
        type: 'object',
        description: 'One slide: a heading plus bullet points.',
        properties: {
          title: { type: 'string', description: 'Slide heading.' },
          bullets: {
            type: 'array',
            description: 'Bullet lines for this slide.',
            items: { type: 'string', description: 'Bullet text.' },
          },
          notes: { type: 'string', description: 'Optional speaker notes (not shown on the slide).' },
        },
      },
    },
    accentColor: {
      type: 'string',
      required: false,
      description: 'Hex accent colour for headings, e.g. "1F4E79". Defaults to a neutral blue.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const outputPath = params['outputPath'] as string | undefined;
    const title = params['title'] as string | undefined;
    const subtitle = params['subtitle'] as string | undefined;
    const rawSlides = params['slides'] as unknown[] | undefined;
    const accent = ((params['accentColor'] as string | undefined) ?? '1F4E79').replace(/^#/, '');

    logger.info({ session: ctx.sessionId, outputPath, title }, 'pptx.create invoked');

    if (!outputPath?.trim()) return { success: false, output: 'outputPath is required.' };
    if (!outputPath.toLowerCase().endsWith('.pptx')) {
      return { success: false, output: `outputPath must end in .pptx. Got: ${outputPath}` };
    }
    if (!isAllowedPath(outputPath)) {
      return {
        success: false,
        output: `outputPath must be under /tmp/ or ${PROJECT_ROOT}/data/pptx/. Got: ${outputPath}`,
      };
    }
    if (!title?.trim()) return { success: false, output: 'title is required.' };
    if (!rawSlides || !Array.isArray(rawSlides) || rawSlides.length === 0) {
      return { success: false, output: 'slides array is required and must not be empty.' };
    }
    if (!/^[0-9A-Fa-f]{6}$/.test(accent)) {
      return { success: false, output: `accentColor must be a 6-digit hex colour. Got: ${accent}` };
    }

    const slides = rawSlides as SlideDef[];
    for (const s of slides) {
      const hasBullets = Array.isArray(s.bullets) && s.bullets.length > 0;
      if (!s.title?.trim() && !hasBullets) {
        return { success: false, output: 'Each slide needs a title or at least one bullet.' };
      }
    }

    try {
      await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });

      const mod = (await import('pptxgenjs')) as unknown as { default: new () => PptxInstance };
      const PptxGenJS = mod.default;
      const deck = new PptxGenJS();
      deck.defineLayout(LAYOUT);
      deck.layout = LAYOUT.name;

      // Title slide
      const cover = deck.addSlide();
      cover.addText(title, {
        x: 0.7, y: 2.4, w: 11.9, h: 1.4,
        fontSize: 40, bold: true, color: accent, align: 'left',
      });
      if (subtitle?.trim()) {
        cover.addText(subtitle, {
          x: 0.7, y: 3.8, w: 11.9, h: 0.8, fontSize: 20, color: '555555', align: 'left',
        });
      }

      // Content slides
      for (const s of slides) {
        const slide = deck.addSlide();
        if (s.title?.trim()) {
          slide.addText(s.title, {
            x: 0.7, y: 0.5, w: 11.9, h: 0.9, fontSize: 28, bold: true, color: accent,
          });
        }
        const bullets = (s.bullets ?? []).filter((b) => typeof b === 'string' && b.trim() !== '');
        if (bullets.length > 0) {
          slide.addText(
            bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
            { x: 0.9, y: 1.6, w: 11.5, h: 5.2, fontSize: 18, color: '222222', lineSpacingMultiple: 1.3 },
          );
        }
        if (s.notes?.trim()) slide.addNotes(s.notes);
      }

      await deck.writeFile({ fileName: outputPath });
      const { size } = await stat(outputPath);

      // Phrasing matches the file-attachment extractor so the deck is delivered.
      return {
        success: true,
        output:
          `Presentation saved to: ${outputPath}\n` +
          `${slides.length + 1} slides (title + ${slides.length}), ${(size / 1024).toFixed(1)} KB, editable .pptx`,
      };
    } catch (err) {
      logger.error({ err: String(err), outputPath }, 'pptx.create failed');
      return { success: false, output: `Failed to create presentation: ${String(err).slice(0, 300)}` };
    }
  },
};

/** Minimal structural typing for the pptxgenjs surface used here. */
interface PptxTextOpts { [k: string]: unknown }
interface PptxSlide {
  addText(text: string | Array<{ text: string; options?: PptxTextOpts }>, opts: PptxTextOpts): void;
  addNotes(notes: string): void;
}
interface PptxInstance {
  layout: string;
  defineLayout(l: { name: string; width: number; height: number }): void;
  addSlide(): PptxSlide;
  writeFile(o: { fileName: string }): Promise<string>;
}

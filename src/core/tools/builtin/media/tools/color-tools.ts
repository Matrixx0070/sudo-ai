/**
 * @file color-tools.ts
 * @description media.color-audit + media.color-check — color accessibility and
 * palette toolkit wrapping the vendored scripts from grok's color skill
 * (scripts/color/): dominant-color extraction with WCAG contrast pairing and
 * colorblind (CVD) simulation for images, and contrast/CVD/palette analysis
 * for hex colors. Pure python + PIL, no network. Guidance doc:
 * scripts/color/COLOR_GUIDE.md.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('media:color');
const execFileAsync = promisify(execFile);

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'color');

/**
 * Run a color script and return its report. These scripts follow the CI
 * convention of exiting 1 when they FIND issues (failing contrast, hazards)
 * while still printing the full report — that is a successful analysis, not an
 * error, so a nonzero exit with stdout returns the stdout.
 */
async function py(script: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('python3', [path.join(SCRIPTS, script), ...args], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    if (typeof e.stdout === 'string' && e.stdout.trim() !== '') return e.stdout;
    throw err;
  }
}

function errMsg(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
}

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
function normHex(h: string): string {
  return h.startsWith('#') ? h : `#${h}`;
}

// ---------------------------------------------------------------------------
// media.color-audit
// ---------------------------------------------------------------------------

export const colorAuditTool: ToolDefinition = {
  name: 'media.color-audit',
  description:
    'Audit the colors of an image (screenshot, slide render, thumbnail, UI mockup): dominant ' +
    'colors with share, WCAG contrast ratios between likely text/background pairs, and ' +
    'colorblind-safety issues. Use after rendering visuals to catch low-contrast or ' +
    'inaccessible color choices before delivering.',
  category: 'media',
  timeout: 40_000,
  parameters: {
    imagePath: { type: 'string', required: true, description: 'Absolute path to an existing PNG/JPG image.' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const imagePath = String(args['imagePath'] ?? '');
    if (!imagePath.startsWith('/')) return { success: false, output: 'media.color-audit error: imagePath must be absolute' };
    if (!/\.(png|jpe?g|webp|gif)$/i.test(imagePath)) {
      return { success: false, output: 'media.color-audit error: imagePath must be a PNG/JPG/WebP/GIF image' };
    }
    if (!existsSync(imagePath)) return { success: false, output: `media.color-audit error: file not found: ${imagePath}` };

    try {
      const out = await py('audit_image.py', [imagePath, '--json']);
      let report: unknown;
      try {
        report = JSON.parse(out);
      } catch {
        report = null;
      }
      logger.info({ imagePath }, 'media.color-audit ok');
      return {
        success: true,
        output: out.trim().slice(0, 12_000),
        data: { imagePath, ...(report && typeof report === 'object' ? { report } : {}) },
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ imagePath, err: msg }, 'media.color-audit error');
      return { success: false, output: `media.color-audit error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// media.color-check
// ---------------------------------------------------------------------------

export const colorCheckTool: ToolDefinition = {
  name: 'media.color-check',
  description:
    'Analyze hex colors before using them in a design. One color: generate its 11-shade scale ' +
    '(50–950) with per-shade use cases. Two colors: WCAG contrast ratio (AA/AAA verdicts for ' +
    'normal/large text) plus colorblind-confusion and chromostereopsis risk. Use when picking ' +
    'palettes for slides, charts, thumbnails, or UI.',
  category: 'media',
  timeout: 30_000,
  parameters: {
    colors: {
      type: 'array',
      required: true,
      description: 'One hex ("#0D9488") for a shade scale, or two ["#fg", "#bg"] for contrast + CVD analysis.',
    },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const raw = Array.isArray(args['colors']) ? (args['colors'] as unknown[]).map(String) : [];
    if (raw.length < 1 || raw.length > 2) {
      return { success: false, output: 'media.color-check error: pass 1 hex (palette) or 2 hexes (contrast)' };
    }
    if (raw.some((c) => !HEX_RE.test(c))) {
      return { success: false, output: 'media.color-check error: colors must be 6-digit hex like "#0D9488"' };
    }
    const colors = raw.map(normHex);

    try {
      if (colors.length === 1) {
        const out = await py('generate_palette.py', [colors[0]!]);
        logger.info({ colors }, 'media.color-check palette ok');
        return { success: true, output: out.trim(), data: { mode: 'palette', colors } };
      }
      const contrast = await py('check_contrast.py', [colors[0]!, colors[1]!, '--json']);
      const cvd = await py('simulate_cvd.py', [colors[0]!, colors[1]!]);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(contrast);
      } catch {
        /* keep raw */
      }
      logger.info({ colors }, 'media.color-check contrast ok');
      return {
        success: true,
        output: `${contrast.trim()}\n${cvd.trim()}`,
        data: { mode: 'contrast', colors, ...(parsed && typeof parsed === 'object' ? { contrast: parsed } : {}) },
      };
    } catch (err) {
      const msg = errMsg(err);
      logger.error({ colors, err: msg }, 'media.color-check error');
      return { success: false, output: `media.color-check error: ${msg}` };
    }
  },
};

/**
 * @file templates.ts
 * @description pptx.find_template — BM25 search over the vendored library of
 * 193 professionally-designed pptxgenjs template decks (grok pptx skill), each
 * described in template_taxonomy.json by color scheme, typography, density,
 * background, accents, and mood. The intended workflow (creating.md, vendored
 * alongside): find a template → copy its .js to a work dir → adapt content
 * while preserving the design system → `node <file>.js` to produce the .pptx
 * (pptxgenjs is a repo dependency) → visual-QA with pptx.render_slides.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT } from '../../../../shared/paths.js';

const logger = createLogger('pptx:templates');
const execFileAsync = promisify(execFile);

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH = path.join(BASE, 'scripts', 'search_templates.py');
const TEMPLATES = path.join(BASE, 'templates');

const FIELD_FLAGS = ['mood', 'color', 'density', 'typography', 'background', 'accent'] as const;

export const pptxFindTemplateTool: ToolDefinition = {
  name: 'pptx.find_template',
  description:
    'Search 193 professionally-designed pptxgenjs deck templates by visual attributes (BM25). ' +
    'PREFER this over building a deck from scratch: pass keywords derived from topic/audience/' +
    'tone (e.g. "dark tech startup") and optional field filters (mood, color, density, ' +
    'typography, background, accent). Each result includes templatePath — copy that .js to a ' +
    'work dir, adapt titles/data/text while KEEPING its design system, run ' +
    '`NODE_PATH=<projectRoot>/node_modules node <file>.js` to produce the .pptx (pptxgenjs ' +
    'resolves from the project), then QA with pptx.render_slides. Full workflow: creating.md.',
  category: 'content',
  timeout: 30_000,
  parameters: {
    query: { type: 'string', required: false, description: 'Keywords searched across all fields.' },
    mood: { type: 'string', required: false, description: 'Filter: mood (e.g. "corporate", "academic").' },
    color: { type: 'string', required: false, description: 'Filter: color scheme (e.g. "white red").' },
    density: { type: 'string', required: false, description: 'Filter: visual density (e.g. "minimalist", "data-heavy").' },
    typography: { type: 'string', required: false, description: 'Filter: typography (e.g. "serif").' },
    background: { type: 'string', required: false, description: 'Filter: background.' },
    accent: { type: 'string', required: false, description: 'Filter: accent elements.' },
    limit: { type: 'number', required: false, description: 'Max results (default 5).' },
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const cliArgs: string[] = [];
    const query = String(args['query'] ?? '').trim();
    if (query) cliArgs.push(...query.split(/\s+/).slice(0, 12));
    for (const flag of FIELD_FLAGS) {
      const v = String(args[flag] ?? '').trim();
      if (v) cliArgs.push(`--${flag}`, v);
    }
    if (cliArgs.length === 0) {
      return { success: false, output: 'pptx.find_template error: provide `query` or at least one field filter' };
    }
    const limit = Number(args['limit']);
    cliArgs.push('--limit', String(Number.isInteger(limit) && limit >= 1 && limit <= 25 ? limit : 5));

    try {
      const { stdout } = await execFileAsync('python3', [SEARCH, ...cliArgs], {
        timeout: 25_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const jsonStart = stdout.indexOf('[');
      const entries = (jsonStart >= 0 ? (JSON.parse(stdout.slice(jsonStart)) as Array<Record<string, unknown>>) : []).map(
        (e) => ({ ...e, templatePath: path.join(TEMPLATES, `${String(e['stem'])}.js`) }),
      );
      const missing = entries.filter((e) => !existsSync(String(e['templatePath'])));
      logger.info({ cliArgs, results: entries.length }, 'pptx.find_template ok');
      return {
        success: true,
        output:
          (stdout.split('\n')[0]?.startsWith('#') ? stdout.split('\n')[0] + '\n' : '') +
          JSON.stringify(entries, null, 2).slice(0, 14_000) +
          (missing.length ? `\nWARNING: ${missing.length} result(s) missing on disk` : '') +
          `\nNext: copy templatePath to a work dir, adapt content (keep the design), then run ` +
          `\`NODE_PATH=${PROJECT_ROOT}/node_modules node <file>.js\` and QA with pptx.render_slides.`,
        data: { entries },
      };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e.stderr?.trim() || e.message || String(err)).slice(0, 800);
      logger.error({ cliArgs, err: msg }, 'pptx.find_template error');
      return { success: false, output: `pptx.find_template error: ${msg}` };
    }
  },
};

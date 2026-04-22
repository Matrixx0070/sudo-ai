/**
 * coder.scaffold — Create a project from a template.
 * Generates a complete project structure with package.json, tsconfig, and starter files.
 * Delegates file content to scaffold-templates.ts to stay under 300 lines.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../../types.js';
import { getTemplateFiles, type ScaffoldTemplate } from './scaffold-templates.js';

const VALID_TEMPLATES: ScaffoldTemplate[] = [
  'node-api',
  'react-app',
  'electron-app',
  'express-api',
  'next-app',
  'cli-tool',
];

function sanitizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}

export const scaffoldTool: ToolDefinition = {
  name: 'coder.scaffold',
  description:
    'Create a new project from a template. ' +
    'Generates a complete project structure (package.json, tsconfig.json, source files). ' +
    'Templates: node-api, react-app, electron-app, express-api, next-app, cli-tool.',
  category: 'coder',
  timeout: 30_000,
  parameters: {
    template: {
      type: 'string',
      required: true,
      description: 'Project template to use.',
      enum: VALID_TEMPLATES,
    },
    name: {
      type: 'string',
      required: true,
      description: 'Project name (used in package.json and directory name).',
    },
    path: {
      type: 'string',
      required: false,
      description: 'Absolute or relative path where the project should be created. ' +
        'Defaults to <workingDir>/<name>.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    // Validate template
    const template = params['template'] as string;
    if (!template || !VALID_TEMPLATES.includes(template as ScaffoldTemplate)) {
      return {
        success: false,
        output: `coder.scaffold: invalid template "${template}". Valid: ${VALID_TEMPLATES.join(', ')}`,
      };
    }

    // Validate name
    const rawName = params['name'];
    if (typeof rawName !== 'string' || rawName.trim() === '') {
      return { success: false, output: 'coder.scaffold: "name" parameter is required.' };
    }
    const projectName = sanitizeName(rawName);
    if (projectName === '') {
      return { success: false, output: `coder.scaffold: "${rawName}" produces an empty sanitized name.` };
    }

    // Resolve project root
    const projectRoot = typeof params['path'] === 'string' && params['path'].trim() !== ''
      ? resolve(ctx.workingDir, params['path'])
      : resolve(ctx.workingDir, projectName);

    try {
      const files = getTemplateFiles(template as ScaffoldTemplate, projectName);
      const artifacts: ToolArtifact[] = [];
      const created: string[] = [];

      for (const file of files) {
        const absolutePath = join(projectRoot, file.path);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, file.content, 'utf-8');
        const bytes = Buffer.byteLength(file.content, 'utf-8');
        artifacts.push({ path: absolutePath, action: 'created', size: bytes });
        created.push(file.path);
      }

      log.info(
        { tool: 'coder.scaffold', template, name: projectName, root: projectRoot, files: created.length },
        'Project scaffolded',
      );

      return {
        success: true,
        output:
          `Scaffolded "${template}" project "${projectName}" at ${projectRoot}\n` +
          `Created ${created.length} file(s):\n` +
          created.map((f) => `  ${f}`).join('\n') +
          '\n\nNext steps:\n' +
          `  cd ${projectRoot}\n  pnpm install\n  pnpm dev`,
        data: { template, name: projectName, root: projectRoot, files: created },
        artifacts,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: 'coder.scaffold', template, name: projectName, err }, 'Scaffold failed');
      return { success: false, output: `coder.scaffold error: ${msg}` };
    }
  },
};

export default scaffoldTool;

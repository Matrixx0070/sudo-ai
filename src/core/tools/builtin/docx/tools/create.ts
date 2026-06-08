/**
 * @file create.ts
 * @description docx.create — Creates a DOCX document with title and sections using the docx npm package.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../../../shared/paths.js';

const logger = createLogger('docx:create');

const ALLOWED_DIRS = ['/tmp', dataPath('docx')];

function isAllowedPath(outputPath: string): boolean {
  const resolved = path.resolve(outputPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

export const docxCreateTool: ToolDefinition = {
  name: 'docx.create',
  description:
    'Create a .docx Word document with a title and one or more sections. Each section may have ' +
    'an optional heading and one or more paragraphs. Output must be under /tmp/ or data/docx/.',
  category: 'content',
  timeout: 20_000,
  parameters: {
    outputPath: {
      type: 'string',
      required: true,
      description: `Absolute output path ending in .docx. Must be under /tmp/ or ${PROJECT_ROOT}/data/docx/.`,
    },
    title: {
      type: 'string',
      required: true,
      description: 'Document title, shown as a Heading 1 at the top.',
    },
    sections: {
      type: 'array',
      required: true,
      description: 'Array of document sections.',
      items: {
        type: 'object',
        description: 'A section with optional heading and paragraphs.',
        properties: {
          heading: { type: 'string', description: 'Section heading (optional, rendered as Heading 2).' },
          paragraphs: {
            type: 'array',
            description: 'Array of paragraph text strings.',
            items: { type: 'string', description: 'Paragraph text.' },
          },
        },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const outputPath = params['outputPath'] as string | undefined;
    const title = params['title'] as string | undefined;
    const rawSections = params['sections'] as unknown[] | undefined;

    logger.info({ session: ctx.sessionId, outputPath, title }, 'docx.create invoked');

    if (!outputPath?.trim()) {
      return { success: false, output: 'outputPath is required.' };
    }
    if (!isAllowedPath(outputPath)) {
      return {
        success: false,
        output: `outputPath must be under /tmp/ or ${PROJECT_ROOT}/data/docx/. Got: ${outputPath}`,
      };
    }
    if (!title?.trim()) {
      return { success: false, output: 'title is required.' };
    }
    if (!rawSections || !Array.isArray(rawSections) || rawSections.length === 0) {
      return { success: false, output: 'sections array is required and must not be empty.' };
    }

    type SectionDef = { heading?: string; paragraphs: string[] };
    const sections = rawSections as SectionDef[];

    for (const sec of sections) {
      if (!Array.isArray(sec.paragraphs) || sec.paragraphs.length === 0) {
        return { success: false, output: 'Each section must have at least one paragraph.' };
      }
    }

    try {
      await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });

      const {
        Document,
        Paragraph,
        TextRun,
        HeadingLevel,
        Packer,
        AlignmentType,
      } = await import('docx');

      const children: InstanceType<typeof Paragraph>[] = [];

      // Title
      children.push(
        new Paragraph({
          text: title,
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
        }),
      );

      // Sections
      for (const sec of sections) {
        // Section heading (Heading 2)
        if (sec.heading?.trim()) {
          children.push(
            new Paragraph({
              text: sec.heading,
              heading: HeadingLevel.HEADING_2,
              spacing: { before: 200, after: 100 },
            }),
          );
        }

        // Paragraphs
        for (const paraText of sec.paragraphs) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: String(paraText) })],
              spacing: { after: 120 },
            }),
          );
        }
      }

      const doc = new Document({
        sections: [
          {
            properties: {},
            children,
          },
        ],
        title,
        creator: 'SUDO-AI',
      });

      const buffer = await Packer.toBuffer(doc);
      await writeFile(outputPath, buffer);

      const fileInfo = await stat(outputPath);
      logger.info({ outputPath, sizeBytes: fileInfo.size, sectionCount: sections.length }, 'DOCX created');

      return {
        success: true,
        output: `DOCX created: ${outputPath} (${sections.length} section(s), ${fileInfo.size} bytes)`,
        data: {
          path: outputPath,
          sizeBytes: fileInfo.size,
          sectionCount: sections.length,
        },
        artifacts: [{ path: outputPath, action: 'created', size: fileInfo.size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ outputPath, err: msg }, 'docx.create error');
      return { success: false, output: `docx.create error: ${msg}` };
    }
  },
};

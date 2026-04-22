/** super.build-api — Generate a REST API scaffold from a natural language description. */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../tools/types.js';

const logger = createLogger('super.build-api');

function buildExpressIndex(description: string, resource: string): string {
  const R = resource.charAt(0).toUpperCase() + resource.slice(1);
  const store = `const store = new Map<string, Record<string, unknown>>();\nlet id = 1;`;
  return [
    `// REST API: ${description} | Framework: Express`,
    `import express, { Request, Response, NextFunction } from 'express';`,
    `const app = express(); app.use(express.json());`,
    store,
    `app.get('/${resource}s', (_: Request, r: Response) => r.json({ data: [...store.values()], total: store.size }));`,
    `app.get('/${resource}s/:id', (q: Request, r: Response) => { const x = store.get(q.params['id']??''); return x ? r.json({data:x}) : r.status(404).json({error:'${R} not found'}); });`,
    `app.post('/${resource}s', (q: Request, r: Response) => { if(!q.body) return r.status(400).json({error:'Bad body'}); const i=String(id++),x={i,...q.body as object,createdAt:new Date().toISOString()}; store.set(i,x); return r.status(201).json({data:x}); });`,
    `app.put('/${resource}s/:id', (q: Request, r: Response) => { const i=q.params['id']??''; if(!store.has(i)) return r.status(404).json({error:'${R} not found'}); const x={...store.get(i),...q.body as object,id:i,updatedAt:new Date().toISOString()}; store.set(i,x); return r.json({data:x}); });`,
    `app.delete('/${resource}s/:id', (q: Request, r: Response) => { const i=q.params['id']??''; if(!store.has(i)) return r.status(404).json({error:'${R} not found'}); store.delete(i); return r.status(204).send(); });`,
    `app.use((e: Error, _q: Request, r: Response, _n: NextFunction) => r.status(500).json({error:e.message}));`,
    `app.listen(Number(process.env['PORT']??3000), () => console.log('API ready'));`,
    `export default app;`,
  ].join('\n');
}

function buildFastifyIndex(description: string, resource: string): string {
  const R = resource.charAt(0).toUpperCase() + resource.slice(1);
  return [
    `// REST API: ${description} | Framework: Fastify`,
    `import Fastify from 'fastify';`,
    `const app = Fastify({ logger: true });`,
    `const store = new Map<string, Record<string, unknown>>(); let id = 1;`,
    `app.get('/${resource}s', async () => ({ data: [...store.values()], total: store.size }));`,
    `app.get<{Params:{id:string}}>('/${resource}s/:id', async (q,r) => { const x=store.get(q.params.id); return x ? {data:x} : r.status(404).send({error:'${R} not found'}); });`,
    `app.post<{Body:Record<string,unknown>}>('/${resource}s', async (q,r) => { const i=String(id++),x={i,...q.body,createdAt:new Date().toISOString()}; store.set(i,x); return r.status(201).send({data:x}); });`,
    `app.put<{Params:{id:string};Body:Record<string,unknown>}>('/${resource}s/:id', async (q,r) => { if(!store.has(q.params.id)) return r.status(404).send({error:'${R} not found'}); const x={...store.get(q.params.id),...q.body,id:q.params.id,updatedAt:new Date().toISOString()}; store.set(q.params.id,x); return {data:x}; });`,
    `app.delete<{Params:{id:string}}>('/${resource}s/:id', async (q,r) => { if(!store.has(q.params.id)) return r.status(404).send({error:'${R} not found'}); store.delete(q.params.id); return r.status(204).send(); });`,
    `app.listen({port:Number(process.env['PORT']??3000)}, (e) => { if(e){app.log.error(e);process.exit(1);} });`,
    `export default app;`,
  ].join('\n');
}

function buildPackageJson(framework: string): string {
  const deps =
    framework === 'fastify'
      ? { fastify: '^4.0.0' }
      : { express: '^4.18.0', '@types/express': '^4.17.0' };
  return JSON.stringify(
    {
      name: 'generated-api',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
      scripts: { build: 'tsc', start: 'node dist/index.js', dev: 'tsx index.ts' },
      dependencies: deps,
      devDependencies: { typescript: '^5.0.0', tsx: '^4.0.0' },
    },
    null,
    2,
  );
}

export const apiBuilderTool: ToolDefinition = {
  name: 'super.build-api',
  description: 'Generate a complete REST API scaffold (package.json + index.ts with CRUD routes) from a plain-English description.',
  category: 'superpowers',
  timeout: 30_000,
  parameters: {
    description: { type: 'string', description: 'Plain English description of the API, e.g. "a task manager API".', required: true },
    outputPath: { type: 'string', description: 'Absolute directory where files will be written.', required: true },
    framework: {
      type: 'string',
      description: 'Web framework to use.',
      enum: ['express', 'fastify'],
      default: 'express',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const description = params['description'] as string | undefined;
    const outputPath = params['outputPath'] as string | undefined;
    const framework = (params['framework'] as string | undefined) ?? 'express';

    if (!description) return { success: false, output: 'description is required.' };
    if (!outputPath) return { success: false, output: 'outputPath is required.' };

    logger.info({ session: ctx.sessionId, description, outputPath, framework }, 'Building API scaffold');

    // Derive resource name from description (first meaningful noun)
    const words = description.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
    const stopWords = new Set(['a', 'an', 'the', 'api', 'rest', 'for', 'with', 'and', 'or']);
    const resource = words.find((w) => w.length > 2 && !stopWords.has(w)) ?? 'item';

    try {
      await mkdir(outputPath, { recursive: true });

      const indexContent =
        framework === 'fastify'
          ? buildFastifyIndex(description, resource)
          : buildExpressIndex(description, resource);

      const packageContent = buildPackageJson(framework);

      const indexFile = join(outputPath, 'index.ts');
      const packageFile = join(outputPath, 'package.json');

      await writeFile(indexFile, indexContent, 'utf8');
      await writeFile(packageFile, packageContent, 'utf8');

      logger.info({ outputPath, resource, framework }, 'API scaffold generated');

      const artifacts: ToolArtifact[] = [
        { path: indexFile, action: 'created' },
        { path: packageFile, action: 'created' },
      ];

      return {
        success: true,
        output: `API scaffold generated at ${outputPath}\nResource: ${resource}\nFramework: ${framework}\nFiles: index.ts, package.json\nRun: cd ${outputPath} && npm install && npm run dev`,
        data: { outputPath, resource, framework, files: [indexFile, packageFile] },
        artifacts,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ outputPath, err: msg }, 'API scaffold failed');
      return { success: false, output: `Failed to generate API: ${msg}` };
    }
  },
};

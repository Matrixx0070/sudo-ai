/**
 * @file grok-embeddings.ts
 * @description `sudo-ai grok embeddings <sub>` — manage grok's server-side
 * managed-embedding RAG collections, FREE on the $30 subscription seat.
 *
 * Covers the statsig-free ingest + management half (models, collection CRUD,
 * document add/list). Semantic retrieval is NOT available statsig-free and is
 * intentionally absent — see src/llm/grok-embeddings.ts.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';

async function lib() {
  return import('../../llm/grok-embeddings.js');
}

function reportErr(err: unknown): number {
  console.error(err instanceof Error ? err.message : String(err));
  return 1;
}

/** `grok embeddings models` */
export async function runGrokEmbeddingModels(): Promise<number> {
  try {
    const models = await (await lib()).listGrokEmbeddingModels();
    console.log(models.length ? models.join('\n') : '(no embedding models)');
    return 0;
  } catch (err) {
    return reportErr(err);
  }
}

/** `grok embeddings create <name>` */
export async function runGrokCreateCollection(name: string, opts: { model?: string }): Promise<number> {
  try {
    const c = await (await lib()).createGrokCollection(name, opts.model ? { model: opts.model } : {});
    console.log(`Created ${c.collectionId} ("${c.collectionName}", model ${c.modelName})`);
    return 0;
  } catch (err) {
    return reportErr(err);
  }
}

/** `grok embeddings list` */
export async function runGrokListCollections(): Promise<number> {
  try {
    const cols = await (await lib()).listGrokCollections();
    if (!cols.length) {
      console.log('(no collections)');
      return 0;
    }
    for (const c of cols) {
      console.log(`${c.collectionId}\t${c.collectionName ?? ''}\t${c.documentsCount ?? 0} docs\t${c.modelName ?? ''}`);
    }
    return 0;
  } catch (err) {
    return reportErr(err);
  }
}

/** `grok embeddings delete <collectionId>` */
export async function runGrokDeleteCollection(collectionId: string): Promise<number> {
  try {
    await (await lib()).deleteGrokCollection(collectionId);
    console.log(`Deleted ${collectionId}`);
    return 0;
  } catch (err) {
    return reportErr(err);
  }
}

/** `grok embeddings add <collectionId> <file>` */
export async function runGrokAddDocument(
  collectionId: string,
  file: string,
  opts: { name?: string; contentType?: string },
): Promise<number> {
  let content: Buffer;
  try {
    content = await readFile(file);
  } catch (err) {
    console.error(`Cannot read "${file}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (content.length === 0) {
    console.error('Document is empty.');
    return 1;
  }
  const docName = opts.name ?? path.basename(file);
  try {
    const d = await (await lib()).addGrokDocument(collectionId, docName, content, opts.contentType ? { contentType: opts.contentType } : {});
    console.log(`Added ${d.fileId} ("${d.docName}") — ${d.documentStatus || d.processingStatus}`);
    return 0;
  } catch (err) {
    return reportErr(err);
  }
}

/** `grok embeddings docs <collectionId>` */
export async function runGrokListDocuments(collectionId: string): Promise<number> {
  try {
    const docs = await (await lib()).listGrokDocuments(collectionId);
    if (!docs.length) {
      console.log('(no documents)');
      return 0;
    }
    for (const d of docs) {
      console.log(`${d.fileId}\t${d.name ?? ''}\t${d.status ?? ''}\tchunks=${d.chunksProcessedCount ?? '0'}`);
    }
    return 0;
  } catch (err) {
    return reportErr(err);
  }
}

/** Register the `grok embeddings <sub>` command group on the parent `grok` cmd. */
export function registerGrokEmbeddings(grokCmd: Command): void {
  const emb = grokCmd
    .command('embeddings')
    .description('Manage grok managed-embedding RAG collections — FREE on your subscription (ingest + management; retrieval is NOT statsig-free). Needs SUDO_GROK_WEBSESSION=1');

  emb.command('models').description('List available grok embedding models').action(async () => {
    process.exit(await runGrokEmbeddingModels());
  });
  emb
    .command('create <name>')
    .description('Create a managed embedding collection')
    .option('--model <model>', 'Embedding model (default grok-embedding-small)')
    .action(async (name: string, opts: { model?: string }) => {
      process.exit(await runGrokCreateCollection(name, opts));
    });
  emb.command('list').description('List your embedding collections').action(async () => {
    process.exit(await runGrokListCollections());
  });
  emb
    .command('delete <collectionId>')
    .description('Delete a collection and its indexed documents')
    .action(async (collectionId: string) => {
      process.exit(await runGrokDeleteCollection(collectionId));
    });
  emb
    .command('add <collectionId> <file>')
    .description('Add a document (grok chunks + embeds it server-side)')
    .option('--name <name>', 'Document name (default: file basename)')
    .option('--content-type <type>', 'MIME type (default text/plain)')
    .action(async (collectionId: string, file: string, opts: { name?: string; contentType?: string }) => {
      process.exit(await runGrokAddDocument(collectionId, file, opts));
    });
  emb
    .command('docs <collectionId>')
    .description('List a collection\'s documents + indexing status')
    .action(async (collectionId: string) => {
      process.exit(await runGrokListDocuments(collectionId));
    });
}

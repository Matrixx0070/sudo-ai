/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI Knowledge Engine.
 *
 * Consumers import from 'src/core/knowledge/index.js' to access all
 * knowledge classes, functions, and types.
 */

// Types
export type {
  KnowledgeNode,
  KnowledgeEdge,
  ResearchResult,
  Fact,
  Note,
  ObsidianNote,
} from './types.js';

// Obsidian vault
export { ObsidianVault } from './obsidian.js';

// Knowledge graph
export { KnowledgeGraph } from './knowledge-graph.js';
export { rowToNode, rowToEdge } from './kg-schema.js';
export type { NodeRow, EdgeRow } from './kg-schema.js';

// Research
export { ResearchAgent } from './research-agent.js';

// Fact extraction
export { extractFacts } from './fact-extractor.js';

// Note taking
export { generateNotes } from './note-taker.js';

// Zettelkasten
export { Zettelkasten } from './zettelkasten.js';

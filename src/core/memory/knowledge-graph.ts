// /root/sudo-ai-v4/src/core/memory/knowledge-graph.ts
// Memory-layer wrapper that exposes KnowledgeGraph to the memory subsystem.

import { KnowledgeGraph } from '../knowledge/knowledge-graph.js';
import type { KnowledgeNode } from '../knowledge/types.js';

export class MemoryKnowledgeGraph {
  private kg: KnowledgeGraph;

  constructor(dbPath?: string) {
    this.kg = new KnowledgeGraph(dbPath);
  }

  searchValid(query: string, limit = 10, asOf?: string): KnowledgeNode[] {
    return this.kg.getValidNodes(query, asOf).slice(0, limit);
  }

  toMemoryResults(nodes: KnowledgeNode[]): Array<{ id: string; content: string; score: number; source: string }> {
    return nodes.map((n) => ({
      id: String(n.id),
      content: `${n.title}: ${n.content}`,
      score: 0.7,
      source: 'knowledge-graph',
    }));
  }
}

export type { KnowledgeNode };

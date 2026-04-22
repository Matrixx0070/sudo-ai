/**
 * Knowledge toolkit — registers 4 knowledge tools into the ToolRegistry.
 *
 * Tools registered:
 *   knowledge.research     — Research a topic across web, vault, and knowledge graph
 *   knowledge.graph        — Add/search/connect nodes in the knowledge graph (SQLite)
 *   knowledge.notes        — Convert raw text into structured notes (zettelkasten/outline/cornell)
 *   knowledge.zettelkasten — Atomic note management with graph linking and orphan detection
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('knowledge-builtin');

// ---------------------------------------------------------------------------
// knowledge.research
// ---------------------------------------------------------------------------

const researchTool: ToolDefinition = {
  name: 'knowledge.research',
  description:
    'Research any topic by combining DuckDuckGo web search, Obsidian vault notes, and the knowledge graph. Returns a summary, extracted facts, and source references.',
  category: 'knowledge',
  timeout: 45_000,
  parameters: {
    topic: {
      type: 'string',
      required: true,
      description: 'The topic, question, or query to research.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'] as string | undefined;
    logger.info({ session: ctx.sessionId, topic }, 'knowledge.research invoked');

    if (!topic?.trim()) return { success: false, output: 'topic is required.' };

    try {
      const { ResearchAgent } = await import('../../../knowledge/research-agent.js');
      const agent = new ResearchAgent();
      const result = await agent.research(topic);

      const factLines = result.facts.slice(0, 10).map((f) => `- [${f.type}] ${f.text}`);
      const output = [
        `Research: "${result.topic}"`,
        '',
        result.summary,
        '',
        `Facts (${result.facts.length} total):`,
        ...factLines,
        '',
        `Sources: ${result.webSnippets.length} web, ${result.vaultNotes.length} vault, ${result.graphNodes.length} graph`,
      ].join('\n');

      return { success: true, output, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, err: msg }, 'knowledge.research error');
      return { success: false, output: `Research error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// knowledge.graph
// ---------------------------------------------------------------------------

const graphTool: ToolDefinition = {
  name: 'knowledge.graph',
  description:
    'Manage the knowledge graph: add nodes (concept/entity/event/document/fact), search nodes by text, connect nodes with labelled edges, list edges for a node.',
  category: 'knowledge',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['add-node', 'find-nodes', 'add-edge', 'get-neighbors', 'get-node'],
    },
    nodeType: {
      type: 'string',
      description: 'Node type for add-node.',
      enum: ['concept', 'entity', 'fact', 'note', 'source'],
    },
    title: { type: 'string', description: 'Node title (required for add-node).' },
    content: { type: 'string', description: 'Node content body (required for add-node).' },
    tags: { type: 'string', description: 'Comma-separated tags for the node.' },
    query: { type: 'string', description: 'Search query for find-nodes.' },
    nodeId: { type: 'number', description: 'Node ID (required for add-edge, get-edges, get-node).' },
    toNodeId: { type: 'number', description: 'Target node ID for add-edge.' },
    relation: { type: 'string', description: 'Edge relation label for add-edge (e.g. "relates-to", "contradicts").' },
    limit: { type: 'number', description: 'Max results for find-nodes (default: 10).', default: 10 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'knowledge.graph invoked');

    try {
      const { KnowledgeGraph } = await import('../../../knowledge/knowledge-graph.js');
      const graph = new KnowledgeGraph();

      switch (action) {
        case 'add-node': {
          const title = params['title'] as string | undefined;
          const content = params['content'] as string | undefined;
          const nodeType = ((params['nodeType'] as string | undefined) ?? 'concept') as
            'concept' | 'entity' | 'fact' | 'note' | 'source';
          if (!title?.trim()) return { success: false, output: 'title is required.' };
          const tagsRaw = params['tags'] as string | undefined;
          const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
          const node = graph.addNode(nodeType, title, content ?? '', tags);
          return { success: true, output: `Node added: [${node.type}] "${node.title}" (id: ${node.id})`, data: node };
        }

        case 'find-nodes': {
          const query = params['query'] as string | undefined;
          if (!query?.trim()) return { success: false, output: 'query is required for find-nodes.' };
          const limit = (params['limit'] as number | undefined) ?? 10;
          const nodes = graph.findNodes(query, limit);
          return {
            success: true,
            output: nodes.length > 0
              ? `Found ${nodes.length} node(s): ${nodes.map((n) => `"${n.title}"`).join(', ')}`
              : 'No matching nodes found.',
            data: nodes,
          };
        }

        case 'add-edge': {
          const fromId = params['nodeId'] as number | undefined;
          const toId = params['toNodeId'] as number | undefined;
          const relation = (params['relation'] as string | undefined) ?? 'relates-to';
          if (!fromId) return { success: false, output: 'nodeId is required for add-edge.' };
          if (!toId) return { success: false, output: 'toNodeId is required for add-edge.' };
          const edge = graph.addEdge(fromId, toId, relation);
          return { success: true, output: `Edge added: ${fromId} --[${edge.relation}]--> ${toId}`, data: edge };
        }

        case 'get-neighbors': {
          const nodeId = params['nodeId'] as number | undefined;
          if (!nodeId) return { success: false, output: 'nodeId is required for get-neighbors.' };
          const neighbors = graph.getNeighbors(nodeId, 2);
          return {
            success: true,
            output: `${neighbors.length} neighbor(s) for node ${nodeId}.`,
            data: neighbors,
          };
        }

        case 'get-node': {
          const nodeId = params['nodeId'] as number | undefined;
          if (!nodeId) return { success: false, output: 'nodeId is required for get-node.' };
          const node = graph.getNode(nodeId);
          if (!node) return { success: false, output: `Node ${nodeId} not found.` };
          return { success: true, output: `[${node.type}] "${node.title}": ${node.content.slice(0, 200)}`, data: node };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'knowledge.graph error');
      return { success: false, output: `Knowledge graph error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// knowledge.notes
// ---------------------------------------------------------------------------

const notesTool: ToolDefinition = {
  name: 'knowledge.notes',
  description:
    'Convert raw text into structured notes. Formats: zettelkasten (atomic notes with IDs), outline (hierarchical bullets), cornell (key questions + cues + summary).',
  category: 'knowledge',
  timeout: 15_000,
  parameters: {
    text: {
      type: 'string',
      required: true,
      description: 'Raw text to convert into notes.',
    },
    format: {
      type: 'string',
      required: true,
      description: 'Output note format.',
      enum: ['zettelkasten', 'outline', 'cornell'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = params['text'] as string | undefined;
    const format = params['format'] as string | undefined;
    logger.info({ session: ctx.sessionId, format }, 'knowledge.notes invoked');

    if (!text?.trim()) return { success: false, output: 'text is required.' };
    if (!format) return { success: false, output: 'format is required.' };

    try {
      const { generateNotes } = await import('../../../knowledge/note-taker.js');
      const notes = generateNotes(text, format as 'zettelkasten' | 'outline' | 'cornell');
      const summary = notes
        .slice(0, 5)
        .map((n) => `[${n.zettelId ?? 'note'}] ${n.title}: ${n.content.slice(0, 100)}`)
        .join('\n');
      return {
        success: true,
        output: `Generated ${notes.length} note(s) in ${format} format:\n${summary}`,
        data: notes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ format, err: msg }, 'knowledge.notes error');
      return { success: false, output: `Notes error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// knowledge.zettelkasten
// ---------------------------------------------------------------------------

const zettelkastenTool: ToolDefinition = {
  name: 'knowledge.zettelkasten',
  description:
    'Atomic note management using Zettelkasten methodology: create atomic notes from text, link notes, search notes, find connected notes, and list orphan notes.',
  category: 'knowledge',
  timeout: 20_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['create', 'link', 'search', 'get-connected', 'get-orphans'],
    },
    text: { type: 'string', description: 'Source text to create notes from (required for create).' },
    topic: { type: 'string', description: 'Topic label / folder for the notes (required for create).' },
    fromNote: { type: 'string', description: 'Source note name for link action.' },
    toNote: { type: 'string', description: 'Target note name for link action.' },
    relation: { type: 'string', description: 'Link relation type (default: relates-to).', default: 'relates-to' },
    query: { type: 'string', description: 'Search query for search action.' },
    noteName: { type: 'string', description: 'Note name for get-connected action.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'knowledge.zettelkasten invoked');

    try {
      const { Zettelkasten } = await import('../../../knowledge/zettelkasten.js');
      const zk = new Zettelkasten();

      switch (action) {
        case 'create': {
          const text = params['text'] as string | undefined;
          const topic = params['topic'] as string | undefined;
          if (!text?.trim()) return { success: false, output: 'text is required for create.' };
          if (!topic?.trim()) return { success: false, output: 'topic is required for create.' };
          const notes = zk.create(text, topic);
          return {
            success: true,
            output: `Created ${notes.length} atomic note(s) for topic "${topic}".`,
            data: notes,
          };
        }

        case 'link': {
          const fromNote = params['fromNote'] as string | undefined;
          const toNote = params['toNote'] as string | undefined;
          const relation = (params['relation'] as string | undefined) ?? 'relates-to';
          if (!fromNote?.trim()) return { success: false, output: 'fromNote is required.' };
          if (!toNote?.trim()) return { success: false, output: 'toNote is required.' };
          zk.link(fromNote, toNote, relation);
          return { success: true, output: `Linked "${fromNote}" --[${relation}]--> "${toNote}".` };
        }

        case 'search': {
          const query = params['query'] as string | undefined;
          if (!query?.trim()) return { success: false, output: 'query is required for search.' };
          const results = zk.search(query);
          const totalFound = results.vaultMatches.length + results.graphMatches.length;
          return {
            success: true,
            output: totalFound > 0
              ? `Found ${results.vaultMatches.length} vault note(s) and ${results.graphMatches.length} graph node(s).`
              : 'No notes matched.',
            data: results,
          };
        }

        case 'get-connected': {
          const noteName = params['noteName'] as string | undefined;
          if (!noteName?.trim()) return { success: false, output: 'noteName is required for get-connected.' };
          const connected = zk.getConnected(noteName);
          return {
            success: true,
            output: connected.length > 0
              ? `${connected.length} connected node(s): ${connected.map((n) => n.title).join(', ')}`
              : 'No connected notes.',
            data: connected,
          };
        }

        case 'get-orphans': {
          const orphans = zk.getOrphans();
          return {
            success: true,
            output: orphans.length > 0
              ? `${orphans.length} orphan note(s): ${orphans.slice(0, 10).join(', ')}`
              : 'No orphan notes found.',
            data: orphans,
          };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'knowledge.zettelkasten error');
      return { success: false, output: `Zettelkasten error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const KNOWLEDGE_TOOLS: ToolDefinition[] = [
  researchTool,
  graphTool,
  notesTool,
  zettelkastenTool,
];

/**
 * Register all knowledge tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerKnowledgeTools(registry: ToolRegistry): void {
  logger.info({ count: KNOWLEDGE_TOOLS.length }, 'Registering knowledge tools');
  for (const tool of KNOWLEDGE_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: KNOWLEDGE_TOOLS.length }, 'Knowledge tools registered');
}

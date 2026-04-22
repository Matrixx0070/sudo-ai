/**
 * @file zettelkasten.ts
 * @description Zettelkasten — links ObsidianVault + KnowledgeGraph to provide
 * atomic note management with automatic graph node creation and bi-directional
 * linking.
 *
 * Methods: create, link, search, getConnected, getOrphans
 */

import { createLogger } from '../shared/logger.js';
import type { KnowledgeNode, Note } from './types.js';
import { ObsidianVault } from './obsidian.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { generateNotes } from './note-taker.js';

const log = createLogger('zettelkasten');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map from vault note name → knowledge graph node ID, persisted in memory. */
const noteToNodeId = new Map<string, number>();

// ---------------------------------------------------------------------------
// Zettelkasten
// ---------------------------------------------------------------------------

export class Zettelkasten {
  private readonly vault: ObsidianVault;
  private readonly graph: KnowledgeGraph;

  constructor(vault?: ObsidianVault, graph?: KnowledgeGraph) {
    this.vault = vault ?? new ObsidianVault();
    this.graph = graph ?? new KnowledgeGraph();
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Create one or more atomic Zettelkasten notes from text and persist them
   * to the vault and knowledge graph.
   *
   * @param text  - Source text to atomise.
   * @param topic - Topic label used as tag and folder.
   * @returns     Array of persisted Note objects with vault paths.
   */
  create(text: string, topic: string): Note[] {
    if (!text?.trim()) throw new Error('Zettelkasten.create: text must not be empty');
    if (!topic?.trim()) throw new Error('Zettelkasten.create: topic must not be empty');

    const notes = generateNotes(text, 'zettelkasten');
    const saved: Note[] = [];

    for (const note of notes) {
      if (!note.zettelId) continue;

      const noteName = `${topic}/${note.zettelId}`;
      const fm: Record<string, unknown> = {
        id: note.zettelId,
        topic,
        tags: `[${note.tags.join(', ')}]`,
        created: new Date().toISOString().slice(0, 10),
      };

      const vaultPath = this.vault.writeNote(noteName, note.content, fm);

      // Create corresponding graph node
      const node = this.graph.addNode(
        'note',
        note.title || note.zettelId,
        text.slice(0, 500),
        [...note.tags, topic],
      );

      noteToNodeId.set(noteName, node.id);
      log.info({ noteName, nodeId: node.id, vaultPath }, 'Zettel created');
      saved.push({ ...note });
    }

    return saved;
  }

  // -------------------------------------------------------------------------
  // Link
  // -------------------------------------------------------------------------

  /**
   * Create a bidirectional link between two notes (by name).
   * Adds a wikilink in each note body and an edge in the knowledge graph.
   *
   * @param fromName - Source note name (relative, without .md).
   * @param toName   - Target note name.
   * @param relation - Edge relation label (default: "relates-to").
   */
  link(fromName: string, toName: string, relation = 'relates-to'): void {
    const fromNote = this.vault.readNote(fromName);
    const toNote = this.vault.readNote(toName);

    if (!fromNote) throw new Error(`Zettelkasten.link: note "${fromName}" not found`);
    if (!toNote) throw new Error(`Zettelkasten.link: note "${toName}" not found`);

    // Append wikilink to each note if not already present
    if (!fromNote.wikilinks.includes(toName)) {
      this.vault.writeNote(fromName, `${fromNote.body}\n\n[[${toName}]]`, fromNote.frontmatter);
    }
    if (!toNote.wikilinks.includes(fromName)) {
      this.vault.writeNote(toName, `${toNote.body}\n\n[[${fromName}]]`, toNote.frontmatter);
    }

    // Add edge in graph
    const fromId = noteToNodeId.get(fromName);
    const toId = noteToNodeId.get(toName);

    if (fromId !== undefined && toId !== undefined) {
      this.graph.addEdge(fromId, toId, relation);
    }

    log.info({ fromName, toName, relation }, 'Notes linked');
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Search notes by query across both vault and graph.
   * Returns matching note names (vault) and nodes (graph), deduplicated.
   */
  search(query: string): { vaultMatches: string[]; graphMatches: KnowledgeNode[] } {
    const vaultResults = this.vault.search(query, 20).map((n) => n.name);
    const graphResults = this.graph.findNodes(query, 20);

    log.info({ query, vault: vaultResults.length, graph: graphResults.length }, 'Zettelkasten search');
    return { vaultMatches: vaultResults, graphMatches: graphResults };
  }

  // -------------------------------------------------------------------------
  // Connected
  // -------------------------------------------------------------------------

  /**
   * Return all notes connected to a given note via the knowledge graph (BFS).
   *
   * @param noteName - Starting note name.
   * @param depth    - BFS max depth (default: 2).
   */
  getConnected(noteName: string, depth = 2): KnowledgeNode[] {
    const nodeId = noteToNodeId.get(noteName);
    if (nodeId === undefined) {
      log.warn({ noteName }, 'Note not found in graph index — returning empty');
      return [];
    }
    const neighbors = this.graph.getNeighbors(nodeId, depth);
    log.info({ noteName, nodeId, found: neighbors.length }, 'Connected notes retrieved');
    return neighbors;
  }

  // -------------------------------------------------------------------------
  // Orphans
  // -------------------------------------------------------------------------

  /**
   * Return all vault notes that have no wikilinks to other notes (orphans).
   * These are candidates for linking or archiving.
   */
  getOrphans(): string[] {
    const allNotes = this.vault.listNotes();
    const orphans = allNotes.filter((name) => {
      const note = this.vault.readNote(name);
      return !note || note.wikilinks.length === 0;
    });
    log.info({ total: allNotes.length, orphans: orphans.length }, 'Orphan check complete');
    return orphans;
  }
}

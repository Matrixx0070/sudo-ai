/**
 * @file network.ts
 * @description SpreadingActivationNetwork — associative concept graph with
 * Hebbian co-occurrence learning and exponential activation decay.
 * SQL statements: statements.ts. DB helpers: store.ts.
 */

import type { Database as BetterSqlite3DB } from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessDB } from '../consciousness-db.js';
import { ConsciousnessError } from '../errors.js';
import type { ActivationResult, ConceptEdge, ConceptNode } from './types.js';
import { flushActivations, loadActiveNodes } from './store.js';
import { buildStatements, type NetworkStatements } from './statements.js';

const log = createLogger('consciousness:spreading-activation');

const DECAY_HALF_LIFE_MS = 300_000;
const LN2 = Math.LN2;
const ACTIVATION_FLOOR = 0.01;
const DIRECT_SCALE = 0.8;
const SPREAD_SCALE = 0.4;
const COOCCURRENCE_DELTA = 0.02;
const DEFAULT_EDGE_WEIGHT = 0.5;

const clamp = (v: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, v));
const nowISO = (): string => new Date().toISOString();
const norm = (s: string): string => s.trim().toLowerCase();

interface NodeRow { id: string; activation: number; last_activated: string; total_activations: number; }
interface EdgeRow { from_id: string; to_id: string; weight: number; cooccurrences: number; }

/** Associative concept network with spreading activation, Hebbian learning,
 * and exponential decay. In-memory cache is source of truth; call flush() to persist. */
export class SpreadingActivationNetwork {
  private readonly _db: BetterSqlite3DB;
  private readonly _cdb: ConsciousnessDB;
  private readonly _nodes = new Map<string, ConceptNode>();
  private readonly _s: NetworkStatements;

  constructor(consciousnessDb: ConsciousnessDB) {
    this._cdb = consciousnessDb;
    this._db  = consciousnessDb.getDb();
    this._s   = buildStatements(this._db);

    for (const node of loadActiveNodes(consciousnessDb, ACTIVATION_FLOOR)) {
      this._nodes.set(node.id, node);
    }
    log.info({ warmedNodes: this._nodes.size }, 'SpreadingActivationNetwork ready');
  }

  private _getOrCreate(id: string): ConceptNode {
    let node = this._nodes.get(id);
    if (node) return node;
    const row = this._s.getNode.get(id) as NodeRow | undefined;
    if (row) {
      node = { id: row.id, activation: row.activation, lastActivated: row.last_activated, totalActivations: row.total_activations };
    } else {
      node = { id, activation: 0, lastActivated: nowISO(), totalActivations: 0 };
    }
    this._nodes.set(id, node);
    return node;
  }

  /** Upsert node to DB and increment total_activations. */
  private _persist(node: ConceptNode): void {
    this._s.upsertNode.run(node.id, node.activation, node.lastActivated);
  }

  /** Write updated activation only — does not increment total_activations. */
  private _writeActivation(node: ConceptNode): void {
    this._s.updateActivation.run(node.activation, node.lastActivated, node.id);
  }

  /** Activate concepts and spread activation one hop to neighbors. */
  activate(concepts: string[], intensity = 1.0): ActivationResult {
    if (!Array.isArray(concepts) || concepts.length === 0) {
      throw new ConsciousnessError('activate: concepts must be a non-empty array',
        'consciousness_spreading_invalid_input', { concepts });
    }

    const k = clamp(intensity, 0, 1);
    const ids = concepts.map(norm).filter(Boolean);
    const directlyActivated: string[] = [];
    const spreadMap = new Map<string, number>();

    try {
      this._db.transaction(() => {
        for (const id of ids) {
          const node = this._getOrCreate(id);
          node.activation = clamp(node.activation + k * DIRECT_SCALE);
          node.lastActivated = nowISO();
          node.totalActivations += 1;
          this._persist(node);
          directlyActivated.push(id);

          for (const edge of this._s.edgesFrom.all(id) as EdgeRow[]) {
            const nb = this._getOrCreate(edge.to_id);
            nb.activation = clamp(nb.activation + k * edge.weight * SPREAD_SCALE);
            nb.lastActivated = nowISO();
            this._writeActivation(nb);
            spreadMap.set(edge.to_id, nb.activation);
          }
        }
      })();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(`activate failed: ${msg}`,
        'consciousness_spreading_activate_failed', { ids, cause: msg });
    }

    this.learnCooccurrence(ids);

    const spreadTo = [...spreadMap.entries()].map(([concept, activation]) => ({ concept, activation }));
    const result: ActivationResult = { directlyActivated, spreadTo, totalAffected: directlyActivated.length + spreadTo.length };

    log.debug({ directCount: directlyActivated.length, spreadCount: spreadTo.length }, 'Activation complete');
    return result;
  }

  /** Return the top N most active concepts sorted by activation DESC. */
  getTopActive(count: number): ConceptNode[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(`getTopActive: count must be a positive integer, got ${count}`,
        'consciousness_spreading_invalid_input', { count });
    }
    return [...this._nodes.values()]
      .filter((n) => n.activation >= ACTIVATION_FLOOR)
      .sort((a, b) => b.activation - a.activation)
      .slice(0, count);
  }

  /** Return activation level for a concept (0 if unknown). */
  getActivation(concept: string): number {
    return this._nodes.get(norm(concept))?.activation ?? 0;
  }

  /**
   * Insert a directed edge (upsert). Creates nodes if missing.
   * @param from   - Source concept.
   * @param to     - Target concept.
   * @param weight - Initial weight in [0, 1] (default 0.5).
   */
  addEdge(from: string, to: string, weight = DEFAULT_EDGE_WEIGHT): void {
    const fromId = norm(from);
    const toId   = norm(to);
    if (!fromId || !toId) {
      throw new ConsciousnessError('addEdge: from and to must be non-empty strings',
        'consciousness_spreading_invalid_input', { from, to });
    }
    try {
      this._db.transaction(() => {
        this._persist(this._getOrCreate(fromId));
        this._persist(this._getOrCreate(toId));
        this._s.upsertEdge.run(fromId, toId, clamp(weight));
      })();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(`addEdge failed: ${msg}`,
        'consciousness_spreading_edge_failed', { fromId, toId, cause: msg });
    }
    log.debug({ fromId, toId, weight }, 'Edge added');
  }

  /**
   * Increase edge weight by delta, capped at 1.0.
   * @param from  - Source concept.
   * @param to    - Target concept.
   * @param delta - Weight increment (default 0.05).
   */
  strengthenEdge(from: string, to: string, delta = 0.05): void {
    const fromId = norm(from);
    const toId   = norm(to);
    if (!fromId || !toId) {
      throw new ConsciousnessError('strengthenEdge: from and to must be non-empty strings',
        'consciousness_spreading_invalid_input', { from, to });
    }
    try {
      this._s.strengthenEdge.run(clamp(delta, 0, 1), fromId, toId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(`strengthenEdge failed: ${msg}`,
        'consciousness_spreading_edge_failed', { fromId, toId, cause: msg });
    }
  }

  /**
   * Learn associations between all co-occurring concept pairs.
   * Upserts bidirectional edges and strengthens each by COOCCURRENCE_DELTA.
   * @param concepts - Concepts that co-occurred in the same context.
   */
  learnCooccurrence(concepts: string[]): void {
    const ids = concepts.map(norm).filter(Boolean);
    if (ids.length < 2) return;
    try {
      this._db.transaction(() => {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i] as string;
            const b = ids[j] as string;
            this._s.upsertEdge.run(a, b, DEFAULT_EDGE_WEIGHT);
            this._s.upsertEdge.run(b, a, DEFAULT_EDGE_WEIGHT);
            this._s.strengthenEdge.run(COOCCURRENCE_DELTA, a, b);
            this._s.strengthenEdge.run(COOCCURRENCE_DELTA, b, a);
          }
        }
      })();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(`learnCooccurrence failed: ${msg}`,
        'consciousness_spreading_cooccurrence_failed', { concepts: ids, cause: msg });
    }
    log.debug({ conceptCount: ids.length }, 'Co-occurrence learned');
  }

  /**
   * Get connected concepts sorted by edge weight DESC.
   * @param concept - Source concept.
   * @param count   - Max neighbors to return.
   */
  getRelated(concept: string, count: number): ConceptNode[] {
    const id = norm(concept);
    if (!id) {
      throw new ConsciousnessError('getRelated: concept must be a non-empty string',
        'consciousness_spreading_invalid_input', { concept });
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(`getRelated: count must be a positive integer, got ${count}`,
        'consciousness_spreading_invalid_input', { count });
    }
    return (this._s.edgesRelated.all(id, count) as EdgeRow[])
      .map((e) => this._getOrCreate(e.to_id));
  }

  /**
   * Apply exponential decay to all cached nodes.
   * Half-life = 5 minutes. Nodes below ACTIVATION_FLOOR are evicted.
   * Formula: activation *= exp(-ln2 * deltaMs / halfLife)
   * @param deltaMs - Elapsed time in ms since last decay call.
   */
  decay(deltaMs: number): void {
    if (deltaMs <= 0) return;
    const factor = Math.exp(-LN2 * deltaMs / DECAY_HALF_LIFE_MS);
    try {
      this._db.transaction(() => {
        const toEvict: string[] = [];
        for (const node of this._nodes.values()) {
          node.activation *= factor;
          if (node.activation < ACTIVATION_FLOOR) {
            node.activation = 0;
            toEvict.push(node.id);
          }
          this._writeActivation(node);
        }
        for (const id of toEvict) this._nodes.delete(id);
      })();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(`decay failed: ${msg}`,
        'consciousness_spreading_decay_failed', { deltaMs, cause: msg });
    }
    log.debug({ deltaMs, factor: factor.toFixed(4), cacheSize: this._nodes.size }, 'Decay applied');
  }

  /** Flush in-memory node cache to the DB. Call before shutdown. */
  flush(): void {
    flushActivations(this._cdb, this._nodes);
    log.debug({ count: this._nodes.size }, 'Network flushed to DB');
  }

  /** Return outgoing edges for a concept (for introspection and testing). */
  getEdgesFrom(concept: string): ConceptEdge[] {
    return (this._s.edgesFrom.all(norm(concept)) as EdgeRow[]).map((r) => ({
      fromId: r.from_id, toId: r.to_id, weight: r.weight, cooccurrences: r.cooccurrences,
    }));
  }
}

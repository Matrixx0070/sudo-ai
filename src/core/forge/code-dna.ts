import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { WORKSPACE_DIR } from '../shared/paths.js';

/**
 * Defines the structure of a reusable code pattern extracted from
 * generated modules. Patterns allow SUDO FORGE to learn recurring
 * solutions and reuse them in future generations. Each pattern is
 * identified by a unique id and grouped by category, recording
 * successes and failures over time.
 */
export interface Pattern {
  id: string;
  name: string;
  description: string;
  code: string;
  category: string;
  successCount: number;
  failCount: number;
  lastUsed: string;
}

/**
 * Persists patterns to a local SQLite database and provides basic
 * extraction and similarity search capabilities. The underlying
 * implementation uses synchronous calls from better-sqlite3 to avoid
 * concurrency hazards. TF‑IDF and cosine similarity are computed in
 * memory for small corpora.
 */
export class CodeDNA {
  private db: Database.Database;

  constructor() {
    const dir = join(WORKSPACE_DIR, 'forge');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'dna.db');
    this.db = new Database(dbPath);
  }

  /**
   * Creates the patterns table if it does not already exist. This
   * method must be called before storing or retrieving patterns.
   */
  public initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      code TEXT,
      category TEXT,
      successCount INTEGER DEFAULT 0,
      failCount INTEGER DEFAULT 0,
      lastUsed TEXT
    )`);
  }

  /**
   * Extracts simple patterns from the given TypeScript source. This
   * implementation looks for exported functions and classes. Each
   * pattern’s id incorporates the file path and symbol name to ensure
   * uniqueness.
   *
   * @param code The TypeScript source code.
   * @param filePath The path of the file from which the code came.
   * @returns An array of extracted patterns.
   */
  public extractPatterns(code: string, filePath: string): Pattern[] {
    const patterns: Pattern[] = [];
    const functionRegex = /export\s+function\s+([A-Za-z0-9_]+)/g;
    const classRegex = /export\s+class\s+([A-Za-z0-9_]+)/g;
    let match: RegExpExecArray | null;
    while ((match = functionRegex.exec(code)) !== null) {
      const name = match[1];
      const id = `${filePath}:${name}`;
      patterns.push({
        id,
        name,
        description: `Exported function ${name} from ${filePath}`,
        code,
        category: 'function',
        successCount: 0,
        failCount: 0,
        lastUsed: new Date().toISOString(),
      });
    }
    while ((match = classRegex.exec(code)) !== null) {
      const name = match[1];
      const id = `${filePath}:${name}`;
      patterns.push({
        id,
        name,
        description: `Exported class ${name} from ${filePath}`,
        code,
        category: 'class',
        successCount: 0,
        failCount: 0,
        lastUsed: new Date().toISOString(),
      });
    }
    return patterns;
  }

  /**
   * Stores a pattern in the database. If a pattern with the same id
   * already exists, its code and description are updated but its
   * success/fail counts are preserved. The lastUsed timestamp is set
   * to the current time when storing.
   *
   * @param pattern The pattern to store.
   */
  public storePattern(pattern: Pattern): void {
    // Upsert preserving counts
    const existing = this.db.prepare('SELECT successCount, failCount FROM patterns WHERE id = ?').get(
      pattern.id
    ) as { successCount?: number; failCount?: number } | undefined;
    const successCount = existing?.successCount ?? pattern.successCount;
    const failCount = existing?.failCount ?? pattern.failCount;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO patterns (id, name, description, code, category, successCount, failCount, lastUsed)
         VALUES (@id, @name, @description, @code, @category, @successCount, @failCount, @lastUsed)`
      )
      .run({ ...pattern, successCount, failCount, lastUsed: new Date().toISOString() });
  }

  /**
   * Finds patterns whose descriptions are semantically similar to a
   * provided description. It uses a simple TF–IDF representation and
   * cosine similarity to score each candidate. Only the top `limit`
   * matches are returned.
   *
   * @param description Description to search for.
   * @param limit Maximum number of results to return.
   */
  public findSimilar(description: string, limit = 5): Pattern[] {
    const rows = this.db.prepare('SELECT * FROM patterns').all() as Pattern[];
    if (!rows.length) return [];
    // Build vocabulary of all terms across documents
    const tokenize = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);
    const docs = rows.map((p) => tokenize(p.description));
    const queryTokens = tokenize(description);
    const allTokens = Array.from(new Set(docs.flat().concat(queryTokens)));
    // Compute IDF
    const idf: Record<string, number> = {};
    allTokens.forEach((term) => {
      let count = 0;
      docs.forEach((doc) => {
        if (doc.includes(term)) count++;
      });
      idf[term] = Math.log((docs.length + 1) / (count + 1)) + 1;
    });
    const toVector = (tokens: string[]): Record<string, number> => {
      const tf: Record<string, number> = {};
      tokens.forEach((t) => {
        tf[t] = (tf[t] ?? 0) + 1;
      });
      const vec: Record<string, number> = {};
      Object.keys(tf).forEach((t) => {
        vec[t] = (tf[t] / tokens.length) * idf[t];
      });
      return vec;
    };
    const queryVec = toVector(queryTokens);
    const simScores: { pattern: Pattern; score: number }[] = [];
    rows.forEach((p, idx) => {
      const vec = toVector(docs[idx]);
      // cosine similarity
      let dot = 0;
      let qNorm = 0;
      let pNorm = 0;
      const keys = new Set([...Object.keys(vec), ...Object.keys(queryVec)]);
      keys.forEach((k) => {
        const a = vec[k] ?? 0;
        const b = queryVec[k] ?? 0;
        dot += a * b;
        pNorm += a * a;
        qNorm += b * b;
      });
      const denom = Math.sqrt(pNorm) * Math.sqrt(qNorm);
      const score = denom === 0 ? 0 : dot / denom;
      simScores.push({ pattern: p, score });
    });
    simScores.sort((a, b) => b.score - a.score);
    return simScores.slice(0, limit).map((s) => s.pattern);
  }

  /**
   * Increments either the success or failure count for a pattern with
   * the given id. If the pattern does not exist, this call does
   * nothing.
   *
   * @param id Pattern id to update.
   * @param success Whether the pattern was successful.
   */
  public scorePattern(id: string, success: boolean): void {
    if (success) {
      this.db.prepare(`UPDATE patterns SET successCount = successCount + 1 WHERE id = ?`).run(id);
    } else {
      this.db.prepare(`UPDATE patterns SET failCount = failCount + 1 WHERE id = ?`).run(id);
    }
  }

  /**
   * Retrieves the top patterns within a category ordered by success and
   * failure counts. When limit is undefined, returns all patterns.
   *
   * @param category Category of interest.
   * @param limit Maximum number of patterns to return.
   * @returns Ordered list of patterns.
   */
  public getTopPatterns(category: string, limit = 5): Pattern[] {
    return this.db
      .prepare(
        `SELECT * FROM patterns WHERE category = ? ORDER BY successCount DESC, failCount ASC LIMIT ?`
      )
      .all(category, limit) as Pattern[];
  }
}
/**
 * @file core/skill-store.ts
 * @description Executable skill memory for the Computer Use Backend.
 *
 * Research (AWM / Voyager-for-GUIs, and the cautionary "naive visual memory is
 * not enough"): what transfers across runs is a VERIFIED, RE-RUNNABLE procedure,
 * not raw screenshot replay. So a Skill is a named, parameterisable action
 * template induced from a plan that actually succeeded. On a later matching
 * subgoal the agent replays the template — skipping the perceive/reason cost of
 * rediscovering the steps.
 *
 * Self-contained JSON store (like the journal / run store), keyed by a
 * normalised subgoal, with simple token-overlap retrieval.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../../../../shared/logger.js';
import { dataPath } from '../../../../shared/paths.js';
import type { Action } from './types.js';

const log = createLogger('computer:skills');

export interface Skill {
  id: string;
  /** Human subgoal this skill accomplishes, e.g. "open a new tab in the browser". */
  subgoal: string;
  /** Normalised token set for retrieval. */
  keywords: string[];
  /** The action template (grounding by AX text/role is preferred for portability). */
  actions: Action[];
  /** Provenance + reliability. */
  timesUsed: number;
  successes: number;
  createdAt: number;
  updatedAt: number;
}

function normalise(subgoal: string): string[] {
  return Array.from(
    new Set(
      subgoal
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    ),
  );
}

export class SkillStore {
  constructor(private readonly baseDir = dataPath('computer-use', 'skills')) {}

  private pathFor(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  /** Induce (or update) a skill from a plan that succeeded. */
  async induce(subgoal: string, actions: Action[]): Promise<Skill> {
    const id = createHash('sha256').update(subgoal.trim().toLowerCase()).digest('hex').slice(0, 16);
    const existing = await this.get(id);
    const now = Date.now();
    const skill: Skill = existing
      ? { ...existing, actions, updatedAt: now }
      : { id, subgoal, keywords: normalise(subgoal), actions, timesUsed: 0, successes: 0, createdAt: now, updatedAt: now };
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.pathFor(id), JSON.stringify(skill), 'utf8');
    log.info({ id, subgoal, steps: actions.length }, 'skill induced');
    return skill;
  }

  async get(id: string): Promise<Skill | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(id), 'utf8')) as Skill;
    } catch {
      return null;
    }
  }

  /** Best matching skill for a subgoal by keyword overlap (Jaccard), above a floor. */
  async find(subgoal: string, minScore = 0.5): Promise<Skill | null> {
    const q = new Set(normalise(subgoal));
    let best: { skill: Skill; score: number } | undefined;
    for (const skill of await this.all()) {
      const k = new Set(skill.keywords);
      const inter = [...q].filter((w) => k.has(w)).length;
      const union = new Set([...q, ...k]).size || 1;
      const score = inter / union;
      if (score >= minScore && (!best || score > best.score)) best = { skill, score };
    }
    return best?.skill ?? null;
  }

  async all(): Promise<Skill[]> {
    try {
      const files = await readdir(this.baseDir);
      const out: Skill[] = [];
      for (const f of files.filter((x) => x.endsWith('.json'))) {
        try {
          out.push(JSON.parse(await readFile(join(this.baseDir, f), 'utf8')) as Skill);
        } catch {
          /* skip corrupt */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Record the outcome of using a skill (feeds future trust). */
  async recordUse(id: string, success: boolean): Promise<void> {
    const s = await this.get(id);
    if (!s) return;
    s.timesUsed++;
    if (success) s.successes++;
    s.updatedAt = Date.now();
    await writeFile(this.pathFor(id), JSON.stringify(s), 'utf8');
  }
}

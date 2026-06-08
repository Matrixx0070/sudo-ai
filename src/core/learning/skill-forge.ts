/**
 * @file skill-forge.ts
 * @description Auto-generates skills from successful tool sequences for SUDO-AI v4.
 *
 * Inspired by Hermes Agent's Learning Loop: after 3+ successful completions
 * of similar tool sequences, automatically generate a SKILL.md file that
 * codifies the pattern so the agent can reuse it in future sessions.
 *
 * Pattern detection pipeline:
 *   1. Query traces for successful tool_call sequences grouped by session
 *   2. Find sequences that appear 3+ times across different sessions
 *   3. For each recurring sequence, compute success rate and average latency
 *   4. If success rate > 80%, generate a skill candidate
 */

import { TraceStore, type TraceRecord } from './trace-store.js';
import { TraceAnalyzer } from './trace-analyzer.js';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';

const log = createLogger('learning:skill-forge');

// -- Exported types ----------------------------------------------------------

/** A recurring tool sequence pattern extracted from trace history. */
export interface ToolPattern {
  toolSequence: string[];       // Ordered list of tool names
  intentPattern: string;        // Summary of the user intent this pattern serves
  successRate: number;          // Fraction of occurrences that succeeded (0-1)
  occurrenceCount: number;      // Number of times this sequence was observed
  avgLatencyMs: number;         // Mean wall-clock latency across all occurrences
}

/** A candidate skill generated from a validated ToolPattern. */
export interface SkillCandidate {
  pattern: ToolPattern;         // The recurring pattern that triggered generation
  generatedSkill: string;       // Full SKILL.md content (frontmatter + body)
  confidence: number;           // Confidence score derived from pattern metrics
}

/** Result of accepting or rejecting a skill candidate. */
export interface ForgeResult {
  skillName: string;            // Kebab-case skill name
  skillPath: string;            // Absolute path to the written SKILL.md
  pattern: ToolPattern;         // Pattern that was forged
  accepted: boolean;            // Whether the skill was written to disk
  reason?: string;              // Optional rejection reason
}

// -- Constants ---------------------------------------------------------------

const MIN_OCCURRENCES = 3;      // Distinct sessions before a sequence qualifies
const MIN_SUCCESS_RATE = 0.80;  // Minimum success rate to become a candidate
const DEFAULT_SKILL_DIR = 'data/skills';
const MAX_SEQUENCE_LENGTH = 8;  // Longest sub-sequence to extract
// Cooperative-scan batch size: when SUDO_SKILL_FORGE_ASYNC=1, scan() yields to the
// event loop after this many sessions/entries of CPU-bound work so a /forge scan
// over a large trace store doesn't block the loop. Off by default (no yields).
const YIELD_EVERY = 50;

// -- Helpers -----------------------------------------------------------------

/** Derive a kebab-case skill name: ['web_search','scrape','summarize'] -> 'web-search-and-summarize' */
function deriveSkillName(tools: string[]): string {
  if (tools.length === 0) return 'unnamed-skill';
  if (tools.length === 1) return tools[0].replace(/_/g, '-');
  const leading = tools.slice(0, -1).map(t => t.replace(/_/g, '-'));
  const last = tools[tools.length - 1].replace(/_/g, '-');
  return [...leading, 'and', last].join('-');
}

/** Map common tool names to intent verbs for human-readable descriptions. */
const VERB_MAP: Record<string, string> = {
  web_search: 'research', search: 'find', scrape: 'extract',
  summarize: 'summarize', read: 'read', write: 'write',
  edit: 'modify', run: 'execute', test: 'verify',
  analyze: 'analyze', render: 'render', compile: 'build',
};

/** Infer an intent pattern string from a tool sequence. */
function inferIntentPattern(tools: string[]): string {
  return tools.map(t => VERB_MAP[t] ?? t.replace(/_/g, ' ')).join(' then ');
}

/** Build YAML frontmatter + Markdown body for a SKILL.md file. */
function renderSkillMarkdown(name: string, pattern: ToolPattern, confidence: number): string {
  const triggers = pattern.intentPattern.split(' then ').map(v => v.trim().toLowerCase()).filter(Boolean);
  const toolsYaml = pattern.toolSequence.map(t => `  - ${t}`).join('\n');
  const triggersYaml = triggers.map(t => `  - ${t}`).join('\n');
  const title = name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return [
    '---',
    `name: ${name}`,
    `description: ${pattern.intentPattern}`,
    'tools:',
    toolsYaml,
    'triggers:',
    triggersYaml,
    `confidence: ${confidence.toFixed(2)}`,
    '---',
    '',
    `# ${title}`,
    '',
    ...pattern.toolSequence.map((tool, i) => `${i + 1}. Use ${tool} to ${triggers[i] ?? 'process data'}`),
    '',
  ].join('\n');
}

/** Normalise a tool sequence into a grouping key. */
function sequenceKey(tools: string[]): string {
  return tools.join('>');
}

// -- SkillForge --------------------------------------------------------------

/**
 * Auto-generates skills from successful tool sequences.
 * Scans execution traces for recurring patterns, validates them against
 * quality thresholds, and writes accepted patterns as SKILL.md files.
 */
export class SkillForge {
  private traceStore: TraceStore;
  private traceAnalyzer: TraceAnalyzer;
  private skillDir: string;
  private patternsFound = 0;
  private skillsForged = 0;
  private skillsRejected = 0;
  private totalConfidence = 0;

  constructor(traceStore: TraceStore, traceAnalyzer: TraceAnalyzer, skillDir?: string) {
    this.traceStore = traceStore;
    this.traceAnalyzer = traceAnalyzer;
    this.skillDir = skillDir ?? path.resolve(DEFAULT_SKILL_DIR);
  }

  // -- Scanning --------------------------------------------------------------

  /**
   * Scan trace history for recurring successful tool sequences and return
   * skill candidates that pass quality thresholds.
   *
   * Cooperative mode (SUDO_SKILL_FORGE_ASYNC=1, default OFF): the CPU-bound
   * sliding-window extraction yields to the event loop every YIELD_EVERY units
   * of work, so a /forge scan over a large trace store stays responsive instead
   * of blocking the loop. The algorithm and its output are byte-identical to the
   * default path — the only difference is interleaved setImmediate yields. When
   * OFF there are zero macrotask yields (behavior identical to before the flag).
   */
  async scan(): Promise<SkillCandidate[]> {
    const yieldNow = process.env['SUDO_SKILL_FORGE_ASYNC'] === '1'
      ? (): Promise<void> => new Promise((r) => setImmediate(r))
      : null;

    // Step 1: Fetch successful and all tool_call traces for rate computation.
    // better-sqlite3 is synchronous, so each fetch is one blocking call; when
    // cooperative we let the event loop breathe between the two large fetches.
    const successfulTraces = this.traceStore.query({ type: 'tool_call', success: true, limit: 50000 });
    if (yieldNow) await yieldNow();
    const allToolTraces = this.traceStore.query({ type: 'tool_call', limit: 50000 });

    // Step 2: Group and sort traces by session chronologically
    const groupBySession = (traces: TraceRecord[]) => {
      const map = new Map<string, TraceRecord[]>();
      for (const t of traces) {
        const sid = t.sessionId ?? '__no_session__';
        if (!map.has(sid)) map.set(sid, []);
        map.get(sid)!.push(t);
      }
      for (const recs of map.values()) {
        recs.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
      }
      return map;
    };

    const successSessions = groupBySession(successfulTraces);
    const allSessions = groupBySession(allToolTraces);

    // Step 3: Extract sliding-window sub-sequences and count occurrences
    // Track which distinct sessions saw each sequence (for success data)
    const successOcc = new Map<string, { tools: string[]; sessions: Set<string>; latSum: number; latCount: number }>();
    const totalOcc = new Map<string, number>();

    const extractWindows = async (
      sessions: Map<string, TraceRecord[]>,
      target: Map<string, { tools: string[]; sessions: Set<string>; latSum: number; latCount: number }>,
      trackTotal?: Map<string, number>,
      checkSuccess?: boolean,
    ): Promise<void> => {
      let sinceYield = 0;
      for (const [sid, recs] of sessions) {
        const names = recs.map(r => r.toolName).filter((t): t is string => t != null);
        const successes = recs.map(r => r.success);

        for (let len = 2; len <= Math.min(MAX_SEQUENCE_LENGTH, names.length); len++) {
          for (let start = 0; start <= names.length - len; start++) {
            const seq = names.slice(start, start + len);
            const key = sequenceKey(seq);

            // For total-occurrence tracking, count whether the window was fully successful
            if (trackTotal != null) {
              trackTotal.set(key, (trackTotal.get(key) ?? 0) + 1);
              // Only count as a "success occurrence" if every tool in the window succeeded
              if (checkSuccess && successes.slice(start, start + len).every(Boolean)) {
                if (!target.has(key)) {
                  target.set(key, { tools: seq, sessions: new Set(), latSum: 0, latCount: 0 });
                }
                const entry = target.get(key)!;
                entry.sessions.add(sid);
              }
            } else {
              if (!target.has(key)) {
                target.set(key, { tools: seq, sessions: new Set(), latSum: 0, latCount: 0 });
              }
              const entry = target.get(key)!;
              entry.sessions.add(sid);
              for (let i = start; i < start + len; i++) {
                entry.latSum += recs[i].latencyMs ?? 0;
                entry.latCount += 1;
              }
            }
          }
        }
        // Cooperative yield: hand the event loop a turn every YIELD_EVERY sessions.
        if (yieldNow && ++sinceYield >= YIELD_EVERY) { sinceYield = 0; await yieldNow(); }
      }
    };

    // Extract successful-occurrence info from all traces (with success check)
    const successOccMap = new Map<string, { tools: string[]; sessions: Set<string>; latSum: number; latCount: number }>();
    const totalOccMap = new Map<string, number>();
    await extractWindows(allSessions, successOccMap, totalOccMap, true);
    if (yieldNow) await yieldNow();

    // Extract latency data from successful-only traces
    const latencyMap = new Map<string, { tools: string[]; sessions: Set<string>; latSum: number; latCount: number }>();
    await extractWindows(successSessions, latencyMap);

    // Step 4: Merge data and build candidates
    const candidates: SkillCandidate[] = [];

    // Accumulate per-scan stats locally and fold them into the instance counters
    // once at the end, so no shared instance state is read-modified-written across
    // a cooperative await (keeps the merge loop hazard-free if scans ever overlap).
    let scanPatternsFound = 0;
    let scanTotalConfidence = 0;
    let mergeSinceYield = 0;
    for (const [key, entry] of successOccMap) {
      if (yieldNow && ++mergeSinceYield >= YIELD_EVERY) { mergeSinceYield = 0; await yieldNow(); }
      if (entry.sessions.size < MIN_OCCURRENCES) continue;

      const total = totalOccMap.get(key) ?? entry.sessions.size;
      const successTotal = entry.sessions.size; // distinct sessions with full-success windows
      // Use occurrence count from total map; success rate from success/total
      const rate = total > 0 ? successTotal / total : 0;
      if (rate < MIN_SUCCESS_RATE) continue;

      const latEntry = latencyMap.get(key);
      const avgLatencyMs = latEntry && latEntry.latCount > 0
        ? latEntry.latSum / latEntry.latCount : 0;

      const pattern: ToolPattern = {
        toolSequence: entry.tools,
        intentPattern: inferIntentPattern(entry.tools),
        successRate: rate,
        occurrenceCount: total,
        avgLatencyMs,
      };

      // Confidence: weighted blend of success rate (70%) and occurrence depth (30%)
      const occFactor = Math.min(entry.sessions.size / 10, 1);
      const confidence = Math.round((rate * 0.7 + occFactor * 0.3) * 100) / 100;

      const skillName = deriveSkillName(entry.tools);
      const generatedSkill = renderSkillMarkdown(skillName, pattern, confidence);

      candidates.push({ pattern, generatedSkill, confidence });
      scanPatternsFound++;
      scanTotalConfidence += confidence;
    }

    this.patternsFound += scanPatternsFound;
    this.totalConfidence += scanTotalConfidence;
    candidates.sort((a, b) => b.confidence - a.confidence);
    log.info({ candidates: candidates.length, patterns: this.patternsFound }, 'Skill scan complete');
    return candidates;
  }

  // -- Forging ---------------------------------------------------------------

  /** Forge a ToolPattern into a SKILL.md document string. Does NOT write to disk. */
  async forge(pattern: ToolPattern): Promise<string> {
    const skillName = deriveSkillName(pattern.toolSequence);
    const occFactor = Math.min(pattern.occurrenceCount / 10, 1);
    const confidence = Math.round((pattern.successRate * 0.7 + occFactor * 0.3) * 100) / 100;
    const content = renderSkillMarkdown(skillName, pattern, confidence);
    log.info({ skillName, confidence }, 'Skill forged from pattern');
    return content;
  }

  // -- Accept / Reject -------------------------------------------------------

  /**
   * Accept a skill candidate: write it to disk as a SKILL.md file.
   * Refuses to overwrite an existing skill unless the new confidence is higher.
   */
  async accept(candidate: SkillCandidate): Promise<ForgeResult> {
    const skillName = deriveSkillName(candidate.pattern.toolSequence);
    mkdirSync(this.skillDir, { recursive: true });
    const skillPath = path.join(this.skillDir, `${skillName}.md`);

    // Guard: do not overwrite unless new confidence strictly exceeds existing
    if (existsSync(skillPath)) {
      const existing = this.readExistingConfidence(skillPath);
      if (existing != null && existing >= candidate.confidence) {
        const reason = `Existing skill at ${skillPath} has equal or higher confidence (${existing})`;
        log.info({ skillName, reason }, 'Skill accept skipped');
        return { skillName, skillPath, pattern: candidate.pattern, accepted: false, reason };
      }
    }

    writeFileSync(skillPath, candidate.generatedSkill, 'utf8');
    this.skillsForged++;
    this.totalConfidence += candidate.confidence;
    log.info({ skillName, skillPath, confidence: candidate.confidence }, 'Skill accepted and written');
    return { skillName, skillPath, pattern: candidate.pattern, accepted: true };
  }

  /** Reject a skill candidate with a reason. Not written to disk. */
  reject(candidate: SkillCandidate, reason: string): void {
    this.skillsRejected++;
    log.info({
      skillName: deriveSkillName(candidate.pattern.toolSequence),
      confidence: candidate.confidence, reason,
    }, 'Skill candidate rejected');
  }

  // -- Stats -----------------------------------------------------------------

  /** Return summary statistics about forge activity. */
  getStats(): { patternsFound: number; skillsForged: number; skillsRejected: number; avgConfidence: number } {
    const total = this.skillsForged + this.skillsRejected;
    const avgConfidence = total > 0 ? Math.round((this.totalConfidence / total) * 100) / 100 : 0;
    return {
      patternsFound: this.patternsFound,
      skillsForged: this.skillsForged,
      skillsRejected: this.skillsRejected,
      avgConfidence,
    };
  }

  // -- Internal helpers ------------------------------------------------------

  /** Parse the confidence field from an existing SKILL.md's YAML frontmatter. */
  private readExistingConfidence(filePath: string): number | null {
    try {
      const content = readFileSync(filePath, 'utf8');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const confMatch = match[1].match(/^confidence:\s*([\d.]+)/m);
      return confMatch ? parseFloat(confMatch[1]) : null;
    } catch {
      return null;
    }
  }
}
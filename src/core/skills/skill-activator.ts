/**
 * @file skill-activator.ts
 * @description Runtime activation for markdown skills — the matcher that
 * decides which loaded skills apply to an incoming user message, and the
 * formatter that injects their bodies as turn-start system context.
 *
 * Before this module, `triggers:` frontmatter was parsed and then read by
 * nothing: 53 skills loaded at boot and never influenced a turn. Activation
 * is deliberately DETERMINISTIC (normalized whole-word phrase matching, the
 * ToolRouter approach) rather than model-mediated: it costs zero tokens to
 * decide, it is exactly reproducible, and — critically — it makes trigger
 * quality measurable for free (skill.trigger-eval runs THIS function, not a
 * reimplementation).
 *
 * Bounded by design: at most SUDO_SKILL_ACTIVATION_MAX skills injected per
 * turn (default 2, best score first), per-skill body cap, ephemeral system
 * message (never persisted). Kill-switch: SUDO_SKILL_ACTIVATION=0.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('skills:activator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural subset of MarkdownSkill the activator needs. */
export interface ActivatableSkill {
  name: string;
  description?: string;
  content: string;
  /** Plural trigger phrases (preferred). */
  triggers?: string[];
  /** Legacy single trigger phrase. */
  trigger?: string;
}

export interface SkillActivation {
  skill: ActivatableSkill;
  /** The trigger phrase (or, for semantic matches, the anchor text) that matched. */
  phrase: string;
  /** Higher = more specific match (more words, longer phrase); cosine × 1000 for semantic. */
  score: number;
  /** True when the recall assist matched by embedding similarity, not by phrase. */
  semantic?: boolean;
  /** Cosine similarity for semantic matches (0..1). */
  similarity?: number;
}

/** Per-skill body cap in the injected system message. */
export const MAX_INJECTED_BODY_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

/** Default ON per repo policy; SUDO_SKILL_ACTIVATION=0 disables. */
export function isSkillActivationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SKILL_ACTIVATION'] !== '0';
}

/** Max skills injected per turn (default 2, clamped 1..5). */
export function maxActivations(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['SUDO_SKILL_ACTIVATION_MAX']);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.floor(n) : 2;
}

// ---------------------------------------------------------------------------
// Matching (pure — skill.trigger-eval imports these to test the REAL thing)
// ---------------------------------------------------------------------------

/** Lowercase and collapse every non-alphanumeric run to a single space. */
export function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** All trigger phrases for a skill (plural preferred, legacy merged, deduped). */
export function effectiveTriggers(skill: ActivatableSkill): string[] {
  const out: string[] = [];
  for (const t of skill.triggers ?? []) {
    if (typeof t === 'string' && t.trim()) out.push(t.trim());
  }
  if (typeof skill.trigger === 'string' && skill.trigger.trim()) out.push(skill.trigger.trim());
  return [...new Set(out)];
}

/**
 * Match a user message against one skill's trigger phrases.
 * A phrase matches when it appears as a whole-word sequence in the message
 * (punctuation/case-insensitive): "tldr" matches "tldr this thread" but not
 * "xtldr". Returns the strongest match or null.
 */
export function matchTriggers(query: string, skill: ActivatableSkill): SkillActivation | null {
  const nq = normalize(query);
  let best: SkillActivation | null = null;
  for (const phrase of effectiveTriggers(skill)) {
    const np = normalize(phrase);
    if (np.trim() === '') continue;
    if (!nq.includes(np)) continue;
    const words = np.trim().split(' ').length;
    const score = words * 100 + np.length;
    if (!best || score > best.score) best = { skill, phrase, score };
  }
  return best;
}

/** Pick the strongest-matching skills for a message (cap enforced, deterministic order). */
export function selectSkills(
  query: string,
  skills: readonly ActivatableSkill[],
  opts: { max?: number } = {},
): SkillActivation[] {
  const max = opts.max ?? maxActivations();
  const hits: SkillActivation[] = [];
  for (const skill of skills) {
    const m = matchTriggers(query, skill);
    if (m) hits.push(m);
  }
  hits.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return hits.slice(0, max);
}

// ---------------------------------------------------------------------------
// Injection formatting
// ---------------------------------------------------------------------------

/**
 * Format activations as one system message. Bodies are fenced and size-capped;
 * the header tells the model these are OPERATOR-INSTALLED skills to follow,
 * with an escape hatch when the match is coincidental.
 */
export function formatSkillInjection(activations: readonly SkillActivation[]): string {
  const parts: string[] = [
    '# ACTIVE SKILLS',
    'The following operator-installed skills matched this request. Follow their instructions',
    'where they apply; if a skill clearly does not fit what the user is actually asking, say',
    'so briefly and answer normally instead of forcing it.',
  ];
  for (const a of activations) {
    const body = a.skill.content.length > MAX_INJECTED_BODY_CHARS
      ? `${a.skill.content.slice(0, MAX_INJECTED_BODY_CHARS)}\n…(truncated)`
      : a.skill.content;
    const label = a.semantic
      ? `semantic match: "${a.phrase}", similarity ${(a.similarity ?? 0).toFixed(2)}`
      : `matched trigger: "${a.phrase}"`;
    parts.push('', `## Skill: ${a.skill.name} (${label})`, body);
  }
  return parts.join('\n');
}

/**
 * One-call convenience for the agent loop: select + format + log.
 * Deterministic phrase matching decides first (precision path); ONLY when it
 * finds nothing does the semantic recall assist run (skills/semantic-assist.ts,
 * local embeddings, at most one skill). Returns null when activation is
 * disabled or nothing matched.
 */
export async function activateSkillsForMessage(
  message: string,
  skills: readonly ActivatableSkill[] | null | undefined,
  sessionId: string,
): Promise<{ content: string; names: string[] } | null> {
  try {
    if (!isSkillActivationEnabled()) return null;
    if (!skills || skills.length === 0) return null;
    let activations = selectSkills(message, skills);
    // Kill-switch mirrors isSemanticAssistEnabled — checked inline so the
    // assist module (and transitively the embedder) is never imported when off.
    if (activations.length === 0 && process.env['SUDO_SKILL_SEMANTIC_ASSIST'] !== '0') {
      const { selectSemanticSkill } = await import('./semantic-assist.js');
      const semantic = await selectSemanticSkill(message, skills);
      if (semantic) activations = [semantic];
    }
    if (activations.length === 0) return null;
    const names = activations.map((a) => a.skill.name);
    log.info(
      {
        sessionId,
        skills: names,
        phrases: activations.map((a) => a.phrase),
        semantic: activations.some((a) => a.semantic === true) || undefined,
        similarity: activations.find((a) => a.semantic)?.similarity,
      },
      'Markdown skills activated for turn',
    );
    return { content: formatSkillInjection(activations), names };
  } catch (err) {
    log.warn({ sessionId, err: String(err) }, 'Skill activation failed — continuing without skills');
    return null;
  }
}

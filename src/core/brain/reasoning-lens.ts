/**
 * @file reasoning-lens.ts
 * @description Curated analytical-reasoning lenses, injected into the system
 * prompt when the user's task matches. Mirrors system-hints.ts (condition →
 * priority-ranked text), but carries multi-line *frameworks* for HOW to think
 * about a task rather than one-line tool guidance.
 *
 * Two families:
 *  - analytical: general problem-solving frames (root-cause, hypothesis-testing,
 *    cost-benefit, pre-mortem, first-principles, adversarial review).
 *  - strategic:  actor/competition/conflict frames distilled from Jiang Xueqin's
 *    structural-history method — KEPT as neutral analytical lenses only. His
 *    contested worldview claims (power-stack / secret-society / "Pax Judaica"
 *    framing) are deliberately EXCLUDED; only the reusable reasoning patterns
 *    remain, each framed as a hypothesis, never a fact.
 *
 * Usage:
 *   const lens = selectLenses(userMessage);
 *   // pass lens?.text to assembleSystemPrompt({ reasoningLens: lens.text })
 *
 * Kill-switch: SUDO_REASONING_LENS_DISABLE=1.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:reasoning-lens');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReasoningLens {
  /** Stable identifier (for dedup + logging). */
  id: string;
  /** Family — analytical (general) vs strategic (actor/competition/conflict). */
  kind: 'analytical' | 'strategic';
  /** Short title rendered as the lens heading. */
  title: string;
  /** Trigger — fires when the lowercased user message matches. */
  match: RegExp;
  /** Higher wins when lenses are capped for token budget (1–20). */
  priority: number;
  /** The lens body injected into the prompt. */
  block: string;
}

/** Default max lenses injected per turn (priority-ranked). */
const DEFAULT_MAX_LENSES = 2;

// ---------------------------------------------------------------------------
// Lens library
// ---------------------------------------------------------------------------

const LENSES: ReasoningLens[] = [
  // --- analytical ---------------------------------------------------------
  {
    id: 'root-cause',
    kind: 'analytical',
    title: 'Root-Cause Analysis',
    match: /\b(bug|error|fail(ing|ed|ure)?|broken|crash|root\s*cause|regression|flaky|why\s+(is|does|did|won'?t))\b/,
    priority: 15,
    block:
      '- Separate the symptom from the cause; do not fix the first thing you see.\n' +
      '- Ask "why" down the chain (5-whys) until you reach a cause you can change.\n' +
      '- Form 2–3 candidate causes, then run the CHEAPEST disconfirming test first.\n' +
      '- Confirm the fix addresses the cause, not just the symptom.',
  },
  {
    id: 'hypothesis-testing',
    kind: 'analytical',
    title: 'Hypothesis Testing',
    match: /\b(analy[sz]e|analysis|investigat|diagnos|uncertain|hypothes|figure\s+out|unclear|root\s*cause)\b/,
    priority: 10,
    block:
      '- State the competing hypotheses explicitly before gathering evidence.\n' +
      '- For each, name what evidence would CONFIRM and what would REFUTE it.\n' +
      '- Actively seek disconfirming evidence — do not just collect support.\n' +
      '- Keep the weakest-but-not-yet-refuted hypotheses alive; avoid early lock-in.',
  },
  {
    id: 'cost-benefit',
    kind: 'analytical',
    title: 'Decision / Cost–Benefit',
    match: /\b(decide|decision|choose|choice|should\s+(we|i|you)|trade.?off|option|versus|\s+vs\.?\s+|pros and cons|worth it|which (one|approach|option))\b/,
    priority: 11,
    block:
      '- Enumerate the real options (including "do nothing").\n' +
      '- Score each against the criteria that actually matter + their cost/risk.\n' +
      '- State your key assumptions; flag which ones, if wrong, flip the decision.\n' +
      '- Prefer the cheapest REVERSIBLE option when uncertainty is high.',
  },
  {
    id: 'pre-mortem',
    kind: 'analytical',
    title: 'Pre-Mortem',
    match: /\b(plan|launch|ship|rollout|roll out|migrat|deploy|before we|what could go wrong|risk)\b/,
    priority: 10,
    block:
      '- Assume it is six months later and this FAILED. Write the failure story.\n' +
      '- List the failure modes that story implies; rank by likelihood × impact.\n' +
      '- Add a cheap guardrail or checkpoint for the top 1–2 before committing.',
  },
  {
    id: 'first-principles',
    kind: 'analytical',
    title: 'First Principles',
    match: /\b(design|architect|rethink|from scratch|fundamental|first principles|redesign|ground up)\b/,
    priority: 9,
    block:
      '- Strip the problem to its irreducible facts and constraints.\n' +
      '- Separate true constraints from inherited assumptions / "how it\'s always done".\n' +
      '- Rebuild the solution from the fundamentals; justify each added layer.',
  },
  {
    id: 'adversarial',
    kind: 'analytical',
    title: 'Adversarial / Red-Team',
    match: /\b(review|audit|verify|red.?team|attack|exploit|secur(e|ity)|vulnerab|break it|stress.?test|edge case)\b/,
    priority: 16,
    block:
      '- Default to skepticism: try to REFUTE the claim/design, not confirm it.\n' +
      '- Hunt the failure modes: malformed input, concurrency, auth, the empty/huge case.\n' +
      '- Ask "how would an attacker / a hostile reviewer break this?" and answer concretely.\n' +
      '- A finding needs a concrete trigger (input → wrong behavior), not a vibe.',
  },

  // --- strategic (Jiang Bucket-1 lenses, neutralized) ---------------------
  {
    id: 'actor-decode',
    kind: 'strategic',
    title: 'Actor Decode (Want / Fear / Capability)',
    match: /\b(competitor|competition|negotiat|adversary|opponent|rival|stakeholder|incentive|who benefits|motivation|geopolit|cui bono)\b/,
    priority: 13,
    block:
      '- For each actor, decode three fields: WANT (goal) · FEAR (loss they avoid) · CAPABILITY (what they can actually enforce). Behavior ≈ the intersection.\n' +
      '- Cui bono: ask who benefits and who pays — the beneficiary\'s incentive often explains an event better than its stated cause.\n' +
      '- Read statements as signals about the speaker\'s real position, not as facts.\n' +
      '- Treat each actor read as a hypothesis to test, not a certainty.',
  },
  {
    id: 'four-dimensions',
    kind: 'strategic',
    title: 'Four Dimensions of Competition',
    match: /\b(strateg|compet|market|positioning|long game|win|beat|outmaneuver|campaign|moat)\b/,
    priority: 12,
    block:
      '- Assess the contest across four spheres, not just the obvious one: NARRATIVE (perception/story) · POLITICAL (allies + base) · ECONOMIC · OPERATIONAL.\n' +
      '- The flexible actor that adapts means to ends beats the rigid actor that forces everything to serve one fixed plan.\n' +
      '- Score each side on Reflection (can it change course?), Flexibility (can it adapt?), Resilience (can it replenish + sustain?). Low scores predict defeat regardless of raw strength.',
  },
  {
    id: 'escalation',
    kind: 'strategic',
    title: 'Escalation Dynamics',
    match: /\b(escalat|conflict|dispute|standoff|retaliat|provoc|deterrence|tit.for.tat|brinkmanship)\b/,
    priority: 12,
    block:
      '- Lay the conflict out as a ladder of rungs; track who climbs voluntarily vs. who is forced.\n' +
      '- Escalation CONTROL (a calibrated, precise response) beats escalation DOMINANCE (overwhelming force) — the flexible side sets the pace.\n' +
      '- Watch the credibility trap: a party that "must respond to save face" can be baited into self-defeating escalation.',
  },
  {
    id: 'epistemic-stance',
    kind: 'strategic',
    title: 'Epistemic Stance (for predictions)',
    match: /\b(predict|forecast|will\s+(happen|they|it|this)|future|likely|outcome|scenario|what happens if|prognos)\b/,
    priority: 14,
    block:
      '- Speculation, not prophecy: frame outputs as "this MIGHT happen, for these reasons", never "this WILL happen".\n' +
      '- Hold judgment open: keep multiple outcomes live and weigh them; refusing to lock in early is a feature.\n' +
      '- Make it falsifiable: state what would prove the forecast wrong, and treat each forecast as a testable hypothesis to revisit.',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select the reasoning lenses active for a message and render them as a single
 * prompt block. Returns null when nothing matches or the feature is disabled.
 *
 * @param message - The user's latest message.
 * @param opts.max - Max lenses to include (priority-ranked). Default 2.
 */
export function selectLenses(
  message: string,
  opts: { max?: number } = {},
): { ids: string[]; kinds: Array<ReasoningLens['kind']>; text: string } | null {
  if (process.env['SUDO_REASONING_LENS_DISABLE'] === '1') return null;
  if (!message || typeof message !== 'string' || !message.trim()) return null;

  const lower = message.toLowerCase();
  const matched: ReasoningLens[] = [];
  for (const lens of LENSES) {
    try {
      if (lens.match.test(lower)) matched.push(lens);
    } catch (err) {
      log.warn({ lensId: lens.id, err: String(err) }, 'Lens match threw — skipping');
    }
  }
  if (matched.length === 0) return null;

  const max = Math.max(1, opts.max ?? DEFAULT_MAX_LENSES);
  const chosen = matched.sort((a, b) => b.priority - a.priority).slice(0, max);

  const body = chosen.map((l) => `### ${l.title}\n${l.block}`).join('\n\n');
  const text =
    'Apply the relevant frame(s) below as analytical LENSES — hypotheses to sharpen your reasoning, ' +
    'NOT facts or conclusions to assert:\n\n' +
    body;

  const ids = chosen.map((l) => l.id);
  log.debug({ ids }, 'Reasoning lenses selected');
  return { ids, kinds: chosen.map((l) => l.kind), text };
}

/** Register a custom lens at runtime (e.g. from a plugin/skill). */
export function registerLens(lens: ReasoningLens): void {
  if (!lens.id || !lens.block || !(lens.match instanceof RegExp)) {
    log.warn({ lens }, 'registerLens: invalid lens — ignoring');
    return;
  }
  LENSES.push(lens);
  log.info({ lensId: lens.id, kind: lens.kind }, 'Custom reasoning lens registered');
}

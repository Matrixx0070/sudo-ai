/**
 * @file aliases.ts
 * @description Model aliases — the only model names app code is allowed to use.
 *
 * gw-refactor Phase 1: app code asks for a capability tier (`sudo/cheap`,
 * `sudo/frontier`, ...), never a concrete provider model. The mapping to a
 * concrete `provider/model` string lives here and is env-overridable per
 * alias (`LLM_ALIAS_CHEAP=...`), so swapping the fleet is config, not code.
 */

export const SUDO_ALIASES = [
  'sudo/local',
  'sudo/cheap',
  'sudo/mid',
  'sudo/frontier',
  'sudo/embed',
  'sudo/vision',
  // Pinned LLM-judge/comparator route (G-JUDGE). Must be independent of the
  // route under test — the judge-independence rule is enforced in src/llm/judge.ts.
  'sudo/judge',
] as const;

export type SudoAlias = (typeof SUDO_ALIASES)[number];

/**
 * Defaults chosen to match current production behavior (config/.env.example:
 * XAI_MODEL=grok-4-fast-reasoning, XAI_FAST_MODEL=grok-4-fast-non-reasoning,
 * embeddings text-embedding-3-small, browser vision grok-4-fast).
 */
const DEFAULTS: Record<SudoAlias, string> = {
  'sudo/local': 'ollama/llama3.2',
  'sudo/cheap': 'xai/grok-4-fast-non-reasoning',
  'sudo/mid': 'xai/grok-4-fast-reasoning',
  'sudo/frontier': 'anthropic/claude-opus-4-8',
  'sudo/embed': 'openai/text-embedding-3-small',
  'sudo/vision': 'xai/grok-4-fast',
  // Default judge = a cheap anthropic route, deliberately a DIFFERENT provider
  // from the xai-heavy cheap/mid tier so it's independent of the usual routes
  // under test. Override with LLM_ALIAS_JUDGE. When the judge shares a provider
  // with the route under test, the gate holds for human review (see judge.ts).
  'sudo/judge': 'anthropic/claude-haiku-4-5-20251001',
};

/** Env override key for an alias: sudo/frontier → LLM_ALIAS_FRONTIER. */
function envKeyFor(alias: SudoAlias): string {
  return `LLM_ALIAS_${alias.slice('sudo/'.length).toUpperCase()}`;
}

export function isSudoAlias(name: string): name is SudoAlias {
  return (SUDO_ALIASES as readonly string[]).includes(name);
}

/**
 * Resolve an alias to a concrete `provider/model` string.
 * Non-alias inputs pass through unchanged (legacy call sites during
 * migration still hand concrete model strings around).
 */
export function resolveAlias(name: string): string {
  if (!isSudoAlias(name)) return name;
  const override = process.env[envKeyFor(name)];
  return override && override.trim() !== '' ? override.trim() : DEFAULTS[name];
}

/**
 * G-MODELGEN: derive a coarse MODEL GENERATION token from a `provider/model`
 * string — the family + major version, minor/point releases dropped. Used by
 * the F64 succession gate: when the primary brain's generation changes (e.g.
 * `anthropic/opus-4` → `anthropic/opus-5`), succession fires (pause→ack→pulse→
 * unpause). A point bump (`opus-4-8` → `opus-4-9`) is the SAME generation.
 *
 * Examples: anthropic/claude-opus-4-8 → anthropic/opus-4 ·
 * xai/grok-4-fast-reasoning → xai/grok-4 · openai/gpt-4o → openai/gpt-4 ·
 * ollama/llama3.2 → ollama/llama-3.
 */
const MODEL_FAMILIES = [
  'opus', 'sonnet', 'haiku', 'grok', 'gpt', 'llama', 'gemini', 'mistral',
  'qwen', 'deepseek', 'fable', 'o1', 'o3', 'o4',
] as const;

export function modelGenerationOf(model: string): string {
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash).toLowerCase() : '';
  const id = (slash > 0 ? model.slice(slash + 1) : model).toLowerCase();
  const fam = MODEL_FAMILIES.find((f) => id.includes(f));
  const prefix = provider ? `${provider}/` : '';
  if (fam) {
    const major = id.slice(id.indexOf(fam)).match(/[a-z]+[-_\s]?(\d+)/)?.[1];
    return `${prefix}${fam}${major ? `-${major}` : ''}`;
  }
  // Fallback: first token + first number anywhere.
  const base = id.split(/[-/._\s]/)[0] || id;
  const num = id.match(/(\d+)/)?.[1];
  return `${prefix}${base}${num ? `-${num}` : ''}`;
}

/** The current PRIMARY-brain generation (the frontier alias, override-aware). */
export function currentModelGeneration(alias: SudoAlias = 'sudo/frontier'): string {
  return modelGenerationOf(resolveAlias(alias));
}

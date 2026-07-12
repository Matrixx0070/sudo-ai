/**
 * Live skill reload — lets skill.install / skill.apply / skill.rollback / the
 * Directory plugin installer activate a freshly-written SKILL.md WITHOUT a
 * process restart.
 *
 * At boot, cli.ts registers a reloader closure that re-runs the same three steps
 * the boot path does: rescan the skills dir(s), rebuild the skill→tool index on
 * the ToolRegistry, and swap the agent loop's in-memory skill list. The skill
 * tools call reloadSkillsLive() after a successful write.
 *
 * Mirrors the module-singleton pattern used by the consciousness orchestrator:
 * the owner (boot) holds the wiring; callers reach it through this seam without
 * threading the registry/loop through the tool-execution context. When no
 * reloader is registered (e.g. a one-shot CLI invocation with no agent loop),
 * reloadSkillsLive() is a no-op and the caller falls back to the restart hint.
 */
import { createLogger } from '../shared/logger.js';

const log = createLogger('skills:live-reload');

export type SkillReloader = () => Promise<{ count: number }>;

let _reloader: SkillReloader | null = null;

/** Boot registers the reloader closure that captures the registry + agent loop. */
export function registerSkillReloader(fn: SkillReloader): void {
  _reloader = fn;
}

/** True once boot has wired a reloader (i.e. live reload is possible). */
export function canReloadSkillsLive(): boolean {
  return _reloader !== null;
}

/**
 * Re-scan skills and re-wire them into the live registry + agent loop.
 * Returns { reloaded:false } when no reloader is registered, or when the reload
 * throws (fail-open — the write already succeeded, so the caller just advises a
 * restart instead of failing the install).
 */
export async function reloadSkillsLive(): Promise<{ reloaded: boolean; count?: number }> {
  if (!_reloader) return { reloaded: false };
  try {
    const { count } = await _reloader();
    log.info({ count }, 'Skills reloaded live (no restart)');
    return { reloaded: true, count };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Live skill reload failed — restart still activates the change');
    return { reloaded: false };
  }
}

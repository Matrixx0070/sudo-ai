/**
 * @file grok-runtime.ts
 * @description THE EXTRACTION BOUNDARY for the Grok seat modules
 * (docs/GROK_SDK_EXTRACTION_PLAN.md step 1).
 *
 * Every `src/llm/grok-*.ts` module reaches host services (logging, storage
 * location, atomic writes) through THIS file and nowhere else. That is the whole
 * point: the seat modules are destined to be extracted into a standalone package,
 * and this is the single file that has to be reimplemented when they are.
 *
 * Measured before this existed: 33 direct `core/shared/logger.js` imports, 15
 * `core/shared/paths.js`, 1 `core/shared/atomic-write.js` — scattered across 30
 * files. Re-pointing them at one seam turns "audit 30 files" into "swap one
 * file", and `tests/llm/grok-extraction-boundary.test.ts` keeps it that way.
 *
 * Inside sudo-ai these are thin re-exports — identical behaviour, no indirection
 * cost at runtime. In the extracted package they become: a no-op/injectable
 * logger, a `storeDir` constructor option, and a ~20-line atomic write.
 *
 * RULE: this file may import sudo-ai internals. No other `grok-*.ts` may.
 * Adding a new host dependency means adding it HERE, not importing it directly —
 * otherwise the extraction cost silently grows back.
 */

export { createLogger } from '../core/shared/logger.js';
export { writeFileAtomic } from '../core/shared/atomic-write.js';
export { DATA_DIR, PROJECT_ROOT } from '../core/shared/paths.js';
/**
 * Credential root — distinct from DATA_DIR, the instance state root (ADR 0011).
 * Seat token AND web-session stores resolve through this, so isolating state
 * never moves the principal's credentials. In the extracted package this
 * becomes the `storeDir` constructor option.
 */
export { credentialPath } from '../core/shared/paths.js';

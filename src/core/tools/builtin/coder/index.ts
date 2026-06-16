/**
 * Coder toolkit — registers all 20 coder tools into the ToolRegistry.
 *
 * Tools provided:
 *   coder.read-file    — Read files with line numbers
 *   coder.write-file   — Create/overwrite files with mkdir -p
 *   coder.edit-file    — Surgical text edits (replace, insert, delete)
 *   coder.smart-edit   — Edit + instant TypeScript typecheck in one call (USE THIS for TS)
 *   coder.glob         — File pattern matching
 *   coder.grep         — Content search with regex (ripgrep + JS fallback)
 *   coder.multi-read   — Read up to 20 files at once
 *   coder.project-map  — Full codebase structure: tree, exports, deps, large files, recent
 *   coder.typecheck    — Run tsc --noEmit with structured error output grouped by file
 *   coder.git          — Full git operations via execFile
 *   coder.npm          — Package management (npm/pnpm/yarn)
 *   coder.scaffold     — Project scaffolding from templates
 *   coder.review       — Static analysis (security+bugs+performance — 50+ rules)
 *   coder.analyze      — AI deep analysis using Grok 4 (2M ctx) — architecture/security/full audit
 *   coder.arsenal      — UNIFIED autonomous agent: reads+reasons+edits+verifies in one call (Grok 4)
 *   coder.test         — Test runner with structured output
 *   coder.debug        — Error/stack trace analysis with optional auto-fix
 *   coder.swarm        — Parallel multi-agent coding executor for large multi-file tasks (Grok 4)
 *   coder.cache        — Project symbol index and analysis cache for instant lookups
 *   coder.apply-patch  — Freeform find-and-replace patches across one or more files
 *   coder.multi-edit   — Multiple exact-string edits across one or more files in one call
 *   coder.notebook-edit — Edit or insert cells in Jupyter .ipynb notebooks
 */

import type { ToolRegistry } from '../../registry.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { editFileTool } from './edit-file.js';
import { smartEditTool } from './smart-edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { multiReadTool } from './multi-read.js';
import { projectMapTool } from './project-map.js';
import { typecheckTool } from './typecheck.js';
import { gitTool } from './git.js';
import { npmTool } from './npm.js';
import { scaffoldTool } from './project-scaffold.js';
import { codeReviewTool } from './code-review.js';
import { analyzeCodeTool } from './analyze.js';
import { arsenalTool } from './arsenal.js';
import { arsenalV2Tool } from './arsenal-v2/index.js';
import { testRunnerTool } from './test-runner.js';
import { debuggerTool } from './debugger.js';
import { swarmTool } from './swarm.js';
import { cacheTool } from './cache.js';
import { applyPatchTool } from './apply-patch.js';
import { multiEditTool } from './multi-edit.js';
import { notebookEditTool } from './notebook-edit.js';

/** All coder tools in a stable order. */
export const CODER_TOOLS = [
  readFileTool,
  writeFileTool,
  editFileTool,
  smartEditTool,
  globTool,
  grepTool,
  multiReadTool,
  projectMapTool,
  typecheckTool,
  gitTool,
  npmTool,
  scaffoldTool,
  codeReviewTool,
  analyzeCodeTool,
  arsenalTool,
  arsenalV2Tool,
  testRunnerTool,
  debuggerTool,
  swarmTool,
  cacheTool,
  applyPatchTool,
  multiEditTool,
  notebookEditTool,
] as const;

/**
 * Register all Super Coder tools into the provided registry.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerCoderTools(registry: ToolRegistry): void {
  registry.registerMany([...CODER_TOOLS]);
}

// Named re-exports for consumers that import individual tools.
export {
  readFileTool,
  writeFileTool,
  editFileTool,
  smartEditTool,
  globTool,
  grepTool,
  multiReadTool,
  projectMapTool,
  typecheckTool,
  gitTool,
  npmTool,
  scaffoldTool,
  codeReviewTool,
  analyzeCodeTool,
  arsenalTool,
  arsenalV2Tool,
  testRunnerTool,
  debuggerTool,
  swarmTool,
  cacheTool,
  applyPatchTool,
  multiEditTool,
  notebookEditTool,
};

/**
 * @file notebooklm/index.ts
 * @description Barrel for the NotebookLM annex (F39–F80). Background-only; the
 * hot-path dirs (agent/llm/memory/brain) must never import this — enforced by
 * tests/notebooklm/hot-path.test.ts.
 */

export { isNotebookLmEnabled, loadNlmBudgets, rollingSizeBudget, type NlmBudgets } from './config.js';
export {
  NOTEBOOKLM_FOLDERS,
  ensureNotebookLmTree,
  loadNlmFolderCache,
  type NlmFolderMap,
} from './folders.js';
export {
  screenZone2,
  assertZone2,
  screenRecords,
  ZoneScreenError,
  type ZoneScreenResult,
} from './zone-screen.js';
export {
  registerShape,
  getShape,
  allShapes,
  brainRadioShape,
  type ShapeSpec,
  type ShapeContext,
  type ShapeMode,
  type CompiledDoc,
} from './shapes.js';
export {
  compileAndExport,
  splitToBudget,
  HEADER_SENTENCE,
  type ExportResult,
} from './export-lane.js';
export {
  parseReturnFilename,
  categoryFor,
  tierFor,
  registerReturnRoute,
  processReturnsOnce,
  listHeldReturns,
  type ParsedReturn,
  type ReturnsDeps,
  type ReturnsSweepResult,
  type ReturnRoute,
} from './returns.js';
export {
  registerRitual,
  allRituals,
  buildRitualManifest,
  assertTier1Budget,
  tier1WeeklyMinutes,
  ensureRitualsTab,
  writeRitualStatus,
  TIER1_WEEKLY_BUDGET_MIN,
  type RitualSpec,
  type RitualTier,
} from './rituals.js';
export {
  getNlmRuntime,
  setNlmInspectorBrain,
  runNlmExportJob,
  runNlmReturnsJob,
  runNlmRitualsJob,
  _resetNlmRuntime,
  type NlmRuntime,
} from './runtime.js';
// N1 broadcast surface
export { redactSecrets } from './zone-screen.js';
export { registerN1Shapes, cockpitShape, architectureShape, researchTargetShape } from './shapes-n1.js';
export { registerN1Rituals } from './rituals-n1.js';
export { registerN1Routes, N1_FORCED_EXTERNAL } from './routes-n1.js';
export {
  exportIncidentPack,
  exportStudyPack,
  type IncidentPackResult,
  type StudyPackResult,
} from './packs.js';

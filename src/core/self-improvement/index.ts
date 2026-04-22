export { runSelfImprovement } from './engine.js';
export { detectPatterns } from './pattern-detector.js';
export type { DetectedPatterns, ToolStats, FeedbackPattern, RoutingGap } from './pattern-detector.js';
export type { ImprovementAction } from './engine.js';

// Upgrade 64: Self-Improvement Loop
export {
  recordInsight,
  getWeaknesses,
  getStrengths,
  getPatterns,
  analyzeForImprovement,
  getSelfReport,
} from './improvement-loop.js';
export type { ImprovementInsight, ActionRecord } from './improvement-loop.js';

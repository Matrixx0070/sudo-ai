/**
 * Research & Learning toolkit — registers 10 tools into the ToolRegistry.
 *
 * Tools registered:
 *   research.deep-search       — Multi-source research via ResearchAgent
 *   research.paper-finder      — Search arXiv / PubMed / Semantic Scholar
 *   research.paper-summarizer  — Download & summarise a paper by URL or arXiv ID
 *   research.literature-review — Full structured literature review on a topic
 *   research.market-research   — Web-based market size / competitor analysis
 *   learn.study-planner        — Personalised study plan with spaced repetition
 *   learn.tutor                — Interactive adaptive tutoring session
 *   learn.exam-prep            — Practice exam generated from syllabus
 *   learn.explain-concept      — Explain any concept at adjustable complexity
 *   learn.homework-helper      — Solve and explain homework step-by-step
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

import {
  deepSearchTool,
  paperFinderTool,
  paperSummarizerTool,
  literatureReviewTool,
  marketResearchTool,
} from './tools/research-tools.js';

import {
  studyPlannerTool,
  tutorTool,
  examPrepTool,
  explainConceptTool,
  homeworkHelperTool,
} from './tools/learn-tools.js';

const logger = createLogger('research-builtin');

// ---------------------------------------------------------------------------
// Tool roster
// ---------------------------------------------------------------------------

const RESEARCH_TOOLS: ToolDefinition[] = [
  deepSearchTool,
  paperFinderTool,
  paperSummarizerTool,
  literatureReviewTool,
  marketResearchTool,
  studyPlannerTool,
  tutorTool,
  examPrepTool,
  explainConceptTool,
  homeworkHelperTool,
];

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all research and learning tools with the given registry.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerResearchTools(registry: ToolRegistry): void {
  logger.info({ count: RESEARCH_TOOLS.length }, 'Registering research tools');
  for (const tool of RESEARCH_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: RESEARCH_TOOLS.length }, 'Research tools registered');
}

// Named re-exports for consumers that import individual tools.
export {
  deepSearchTool,
  paperFinderTool,
  paperSummarizerTool,
  literatureReviewTool,
  marketResearchTool,
  studyPlannerTool,
  tutorTool,
  examPrepTool,
  explainConceptTool,
  homeworkHelperTool,
};

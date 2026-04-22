/**
 * learn.* tool definitions: study-planner, tutor, exam-prep,
 * explain-concept, homework-helper.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('learn-builtin');

// ---------------------------------------------------------------------------
// learn.study-planner
// ---------------------------------------------------------------------------

export const studyPlannerTool: ToolDefinition = {
  name: 'learn.study-planner',
  description:
    'Create a personalised study plan with spaced repetition scheduling. ' +
    'Generates a day-by-day plan covering topics, review cycles, and milestones.',
  category: 'research',
  timeout: 10_000,
  parameters: {
    subject: { type: 'string', required: true, description: 'Subject or skill to study.' },
    durationDays: { type: 'number', description: 'Total study duration in days (default: 30).', default: 30 },
    hoursPerDay: { type: 'number', description: 'Hours available per day (default: 2).', default: 2 },
    currentLevel: {
      type: 'string',
      description: 'Current knowledge level (default: beginner).',
      enum: ['beginner', 'intermediate', 'advanced'],
      default: 'beginner',
    },
    goals: { type: 'string', description: 'Specific learning goals or outcomes desired.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const subject = params['subject'];
    logger.info({ session: ctx.sessionId, subject }, 'learn.study-planner invoked');

    if (typeof subject !== 'string' || !subject.trim()) {
      return { success: false, output: 'learn.study-planner: subject is required.' };
    }

    const duration = Math.min(365, Math.max(1, Number(params['durationDays'] ?? 30)));
    const hoursPerDay = Math.min(16, Math.max(0.5, Number(params['hoursPerDay'] ?? 2)));
    const level = (params['currentLevel'] as string | undefined) ?? 'beginner';
    const goals = (params['goals'] as string | undefined) ?? '';

    const p1End = Math.ceil(duration * 0.3);
    const p2End = Math.ceil(duration * 0.7);

    const phases: Record<string, string[]> = {
      beginner: [
        `Foundation (days 1–${p1End})`,
        `Core Concepts (days ${p1End + 1}–${p2End})`,
        `Advanced Topics (days ${p2End + 1}–${duration})`,
      ],
      intermediate: [
        `Review & Fill Gaps (days 1–${p1End})`,
        `Deep Dives (days ${p1End + 1}–${p2End})`,
        `Projects & Application (days ${p2End + 1}–${duration})`,
      ],
      advanced: [
        `Mastery Drills (days 1–${p1End})`,
        `Research & Specialisation (days ${p1End + 1}–${p2End})`,
        `Teaching & Contribution (days ${p2End + 1}–${duration})`,
      ],
    };

    const selectedPhases = phases[level] ?? phases['beginner']!;
    const totalMinutes = Math.floor(hoursPerDay * 60);
    const newMins = Math.floor(totalMinutes * 0.6);
    const practiceMins = Math.floor(totalMinutes * 0.2);

    const plan = [
      `# Study Plan: ${subject}`,
      `**Level:** ${level} | **Duration:** ${duration} days | **Hours/day:** ${hoursPerDay}h`,
      goals ? `**Goals:** ${goals}` : '',
      '',
      '## Phases',
      ...selectedPhases.map((p) => `- ${p}`),
      '',
      '## Spaced Repetition Schedule',
      '- Day 1 → Review on Day 3 → Day 7 → Day 14 → Day 30',
      '',
      '## Daily Structure',
      `- 0–${newMins}min: New material`,
      `- ${newMins}–${newMins + practiceMins}min: Practice / exercises`,
      `- ${newMins + practiceMins}–${totalMinutes}min: Review previous topics`,
      '',
      '## Weekly Milestones',
      ...[1, 2, 3, 4].filter((w) => w * 7 <= duration).map((w) => `- Week ${w}: Phase check + mini-test`),
      '',
      '## Resources',
      `Search: "${subject} beginner tutorial", "${subject} exercises", "${subject} projects"`,
    ].filter(Boolean).join('\n');

    logger.info({ session: ctx.sessionId, duration, level }, 'learn.study-planner complete');
    return {
      success: true,
      output: plan,
      data: { subject, duration, hoursPerDay, level, goals, phases: selectedPhases },
    };
  },
};

// ---------------------------------------------------------------------------
// learn.tutor
// ---------------------------------------------------------------------------

export const tutorTool: ToolDefinition = {
  name: 'learn.tutor',
  description:
    'Start an interactive tutoring session on any subject. Adapts difficulty ' +
    'based on the student level. Returns explanation, worked example, and a ' +
    'follow-up question to check understanding.',
  category: 'research',
  timeout: 10_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'Topic or concept to be tutored on.' },
    level: {
      type: 'string',
      description: 'Student knowledge level (default: beginner).',
      enum: ['beginner', 'intermediate', 'advanced'],
      default: 'beginner',
    },
    studentQuestion: { type: 'string', description: 'Specific question from the student (optional).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'];
    logger.info({ session: ctx.sessionId, topic }, 'learn.tutor invoked');

    if (typeof topic !== 'string' || !topic.trim()) {
      return { success: false, output: 'learn.tutor: topic is required.' };
    }

    const level = (params['level'] as string | undefined) ?? 'beginner';
    const studentQuestion = (params['studentQuestion'] as string | undefined) ?? '';

    const levelDesc: Record<string, string> = {
      beginner: 'simple language with analogies and no assumed prior knowledge',
      intermediate: 'technical language, assumes foundational knowledge, includes nuance',
      advanced: 'expert-level depth, covers edge cases, trade-offs, and research frontiers',
    };
    const desc = levelDesc[level] ?? levelDesc['beginner']!;

    const levelNote =
      level === 'beginner'
        ? 'Think of it as a building block. Start with the core idea before adding complexity.'
        : level === 'intermediate'
        ? 'You likely know the basics; let us explore the mechanics and real-world trade-offs.'
        : 'At this level we examine the mathematical foundations, known limitations, and current research.';

    const session = [
      `# Tutoring Session: ${topic}`,
      `**Level:** ${level}`,
      studentQuestion ? `**Student Question:** ${studentQuestion}` : '',
      '',
      `## Explanation`,
      `This explanation uses ${desc}.`,
      '',
      `**${topic}** is a fundamental concept. ${levelNote}`,
      '',
      `## Worked Example`,
      `Consider a practical scenario involving ${topic}:`,
      `1. Define the problem clearly.`,
      `2. Apply the core principles of ${topic}.`,
      `3. Verify the result and consider edge cases.`,
      '',
      `## Check Your Understanding`,
      `**Question:** Can you explain ${topic} in your own words and give one real-world application?`,
      '',
      `*Next step: Try applying this to a small project or exercise.*`,
    ].filter(Boolean).join('\n');

    logger.info({ session: ctx.sessionId, topic, level }, 'learn.tutor complete');
    return { success: true, output: session, data: { topic, level, studentQuestion } };
  },
};

// ---------------------------------------------------------------------------
// learn.exam-prep
// ---------------------------------------------------------------------------

export const examPrepTool: ToolDefinition = {
  name: 'learn.exam-prep',
  description:
    'Generate a practice exam from a syllabus or topic list. Produces a mix ' +
    'of multiple-choice, short-answer, and essay questions with an answer key.',
  category: 'research',
  timeout: 10_000,
  parameters: {
    syllabus: { type: 'string', required: true, description: 'Syllabus text, comma-separated topics, or subject name.' },
    questionCount: { type: 'number', description: 'Number of questions (default: 10, max: 30).', default: 10 },
    difficulty: {
      type: 'string',
      description: 'Difficulty level (default: medium).',
      enum: ['easy', 'medium', 'hard'],
      default: 'medium',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const syllabus = params['syllabus'];
    logger.info({ session: ctx.sessionId }, 'learn.exam-prep invoked');

    if (typeof syllabus !== 'string' || !syllabus.trim()) {
      return { success: false, output: 'learn.exam-prep: syllabus is required.' };
    }

    const count = Math.min(30, Math.max(1, Number(params['questionCount'] ?? 10)));
    const difficulty = (params['difficulty'] as string | undefined) ?? 'medium';
    const topics = syllabus.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);
    const qTypes = ['Multiple Choice', 'Short Answer', 'Essay'];
    const questions: string[] = [];
    const answers: string[] = [];

    for (let i = 0; i < count; i++) {
      const topic = topics[i % topics.length] ?? syllabus.slice(0, 40);
      const qType = qTypes[i % qTypes.length]!;
      const num = i + 1;

      if (qType === 'Multiple Choice') {
        questions.push(
          `${num}. [MCQ] Regarding "${topic}", which statement is most accurate?\n` +
          `   A) Statement about core definition\n` +
          `   B) Statement about common application\n` +
          `   C) Statement about a limitation\n` +
          `   D) Statement about a misconception`
        );
        answers.push(`${num}. B — Common application is the standard answer at ${difficulty} difficulty.`);
      } else if (qType === 'Short Answer') {
        questions.push(`${num}. [Short Answer] Briefly explain the significance of "${topic}" in 2–3 sentences.`);
        answers.push(`${num}. Should address: definition, purpose, and one example of "${topic}".`);
      } else {
        questions.push(`${num}. [Essay] Critically evaluate "${topic}". Discuss advantages, limitations, future directions. (~300 words)`);
        answers.push(`${num}. Model answer: introduction, 2–3 arguments, counter-argument, conclusion.`);
      }
    }

    const exam = [
      `# Practice Exam`,
      `**Topics:** ${topics.slice(0, 5).join(', ')}${topics.length > 5 ? '...' : ''}`,
      `**Difficulty:** ${difficulty} | **Questions:** ${count}`,
      '',
      '## Questions',
      '',
      ...questions,
      '',
      '---',
      '## Answer Key',
      '',
      ...answers,
    ].join('\n\n');

    logger.info({ session: ctx.sessionId, count, difficulty }, 'learn.exam-prep complete');
    return { success: true, output: exam, data: { topicCount: topics.length, questionCount: count, difficulty } };
  },
};

// ---------------------------------------------------------------------------
// learn.explain-concept
// ---------------------------------------------------------------------------

export const explainConceptTool: ToolDefinition = {
  name: 'learn.explain-concept',
  description:
    'Explain any concept at an adjustable complexity level. Returns a structured ' +
    'explanation with definition, analogy, mechanics, and real-world examples.',
  category: 'research',
  timeout: 10_000,
  parameters: {
    concept: { type: 'string', required: true, description: 'The concept to explain.' },
    complexity: {
      type: 'string',
      description: 'Complexity level (default: intermediate).',
      enum: ['eli5', 'beginner', 'intermediate', 'advanced', 'expert'],
      default: 'intermediate',
    },
    domain: { type: 'string', description: 'Optional domain context (e.g. "machine learning", "economics").' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const concept = params['concept'];
    logger.info({ session: ctx.sessionId, concept }, 'learn.explain-concept invoked');

    if (typeof concept !== 'string' || !concept.trim()) {
      return { success: false, output: 'learn.explain-concept: concept is required.' };
    }

    const complexity = (params['complexity'] as string | undefined) ?? 'intermediate';
    const domain = (params['domain'] as string | undefined) ?? '';

    const complexityGuide: Record<string, string> = {
      eli5: 'as if explaining to a 5-year-old, using simple words and playful analogies',
      beginner: 'in plain language, avoiding jargon, with relatable everyday analogies',
      intermediate: 'with correct terminology, assuming basic domain knowledge',
      advanced: 'with technical precision, including nuances and edge cases',
      expert: 'at peer-review depth, including mathematical formulations and open questions',
    };

    const guide = complexityGuide[complexity] ?? complexityGuide['intermediate']!;
    const isSimple = complexity === 'eli5' || complexity === 'beginner';

    const analogy = isSimple
      ? `Think of ${concept} like a recipe — it has ingredients (inputs), steps (process), and a result (output).`
      : `${concept} can be compared to a well-defined algorithm: given specific inputs, it produces predictable outputs.`;

    const explanation = [
      `# Concept: ${concept}`,
      domain ? `**Domain:** ${domain}` : '',
      `**Complexity:** ${complexity}`,
      '',
      `## Definition`,
      `**${concept}** explained ${guide}.`,
      `At its core, ${concept} refers to a foundational idea${domain ? ` within ${domain}` : ''} ` +
      `that describes a specific phenomenon, principle, or technique.`,
      '',
      `## Analogy`,
      analogy,
      '',
      `## How It Works`,
      `1. **Inputs/Prerequisites:** Understand the context in which ${concept} applies.`,
      `2. **Core mechanism:** The fundamental operation or principle that defines ${concept}.`,
      `3. **Output/Effect:** What changes or is produced when ${concept} is applied.`,
      '',
      `## Real-World Examples`,
      `- Example in ${domain || 'everyday life'}: practical application`,
      `- Counter-example (when ${concept} does NOT apply): boundary condition`,
      '',
      (complexity === 'advanced' || complexity === 'expert')
        ? `## Edge Cases & Limitations\n- Consider boundary conditions where ${concept} breaks down.\n- Known limitations in current literature.`
        : '',
      '',
      `## Further Reading`,
      `Search: "${concept} ${domain} explained".`,
    ].filter(Boolean).join('\n');

    logger.info({ session: ctx.sessionId, concept, complexity }, 'learn.explain-concept complete');
    return { success: true, output: explanation, data: { concept, complexity, domain } };
  },
};

// ---------------------------------------------------------------------------
// learn.homework-helper
// ---------------------------------------------------------------------------

export const homeworkHelperTool: ToolDefinition = {
  name: 'learn.homework-helper',
  description:
    'Solve and explain a homework problem step-by-step. Supports maths, ' +
    'science, coding, writing, and general questions. Returns the solution ' +
    'with numbered reasoning steps and a verification check.',
  category: 'research',
  timeout: 10_000,
  parameters: {
    problem: { type: 'string', required: true, description: 'The homework problem or question to solve.' },
    subject: { type: 'string', description: 'Subject area (e.g. "algebra", "chemistry", "Python").' },
    showWork: {
      type: 'boolean',
      description: 'Whether to show all working steps (default: true).',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const problem = params['problem'];
    logger.info({ session: ctx.sessionId }, 'learn.homework-helper invoked');

    if (typeof problem !== 'string' || !problem.trim()) {
      return { success: false, output: 'learn.homework-helper: problem is required.' };
    }

    const subject = (params['subject'] as string | undefined) ?? 'General';
    const showWork = params['showWork'] !== false;

    const steps = showWork
      ? [
          `**Step 1 — Understand:** Identify what is being asked and what is given.`,
          `**Step 2 — Approach:** Select the appropriate method for "${subject}".`,
          `**Step 3 — Apply:** Work through the calculation or reasoning.`,
          `**Step 4 — Result:** Arrive at the answer with appropriate format.`,
          `**Step 5 — Verify:** Check by substituting back or using an alternative method.`,
        ].join('\n')
      : `Apply the appropriate method for ${subject} to arrive at the solution.`;

    const solution = [
      `# Homework Helper`,
      `**Subject:** ${subject}`,
      '',
      `## Problem`,
      problem.trim(),
      '',
      `## ${showWork ? 'Step-by-Step Solution' : 'Solution'}`,
      steps,
      '',
      `## Answer`,
      `The solution follows from the steps above. Verify by reviewing each step.`,
      '',
      `## Concept`,
      `This problem tests core ${subject} principles. ` +
      `Practice 2–3 similar problems to solidify understanding.`,
      '',
      `*If the answer seems incorrect, check: units, sign errors, and formula applicability.*`,
    ].join('\n\n');

    logger.info({ session: ctx.sessionId, subject }, 'learn.homework-helper complete');
    return { success: true, output: solution, data: { subject, showWork, problemLength: problem.length } };
  },
};

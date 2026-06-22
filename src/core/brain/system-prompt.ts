/**
 * System prompt assembly for the Brain module.
 *
 * Reads workspace files and combines them with runtime context (persona,
 * mood, tools, memory) into a single ordered system prompt string.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { PATHS } from '../shared/constants.js';
import { PROJECT_ROOT } from '../shared/paths.js';
import { getPersonaSystemBlock } from './personas.js';
import { getMoodSystemBlock } from './moods.js';
import { isPromptCacheEnabled, sortByName, DYNAMIC_BOUNDARY_MARKER } from './prompt-cache-discipline.js';
import { getCapabilityManifestBody, isCapabilityManifestEnabled } from './capability-manifest.js';
import type { SystemPromptOptions } from './types.js';

const log = createLogger('brain:system-prompt');

// ---------------------------------------------------------------------------
// Workspace file reader
// ---------------------------------------------------------------------------

/**
 * Read a file from the workspace/ directory.
 * Returns empty string when the file is absent — missing workspace files are
 * not fatal; the system operates with whatever is present.
 *
 * @param name - Filename relative to workspace/, e.g. "SOUL.md".
 */
export async function readWorkspaceFile(name: string): Promise<string> {
  if (!name || typeof name !== 'string') {
    log.warn({ name }, 'readWorkspaceFile: invalid filename');
    return '';
  }

  // Prevent path traversal.
  const safeName = path.basename(name);
  const filePath = path.resolve(PATHS.WORKSPACE, safeName);

  try {
    const content = await readFile(filePath, 'utf8');
    log.debug({ file: safeName, bytes: content.length }, 'Workspace file read');
    return content.trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug({ file: safeName }, 'Workspace file absent — skipping');
    } else {
      log.warn({ file: safeName, err }, 'Workspace file read error — skipping');
    }
    return '';
  }
}

// ---------------------------------------------------------------------------
// Daily memory log reader
// ---------------------------------------------------------------------------

/**
 * Read today's daily memory log from workspace/memory/YYYY-MM-DD.md.
 * Returns empty string when absent.
 */
async function readTodayMemoryLog(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.resolve(PATHS.WORKSPACE, 'memory', `${today}.md`);

  try {
    const content = await readFile(filePath, 'utf8');
    log.debug({ date: today, bytes: content.length }, 'Daily memory log read');
    return content.trim();
  } catch {
    log.debug({ date: today }, 'No daily memory log found — skipping');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Section builder helpers
// ---------------------------------------------------------------------------

function section(content: string): string {
  return content ? `${content}\n\n` : '';
}

function sectionWithHeader(header: string, content: string): string {
  return content ? `## ${header}\n\n${content}\n\n` : '';
}

// ---------------------------------------------------------------------------
// Main assembler
// ---------------------------------------------------------------------------

/**
 * Assemble the full system prompt from workspace files and runtime context.
 *
 * Order:
 *  1. SOUL.md
 *  2. IDENTITY.md
 *  3. USER.md
 *  4. Current date/time
 *  5. Available tools list
 *  6. Active persona instructions
 *  7. Current mood modifiers
 *  8. AGENTS.md
 *  9. TOOLS.md
 * 10. HEARTBEAT.md (when options.heartbeat === true)
 * 11. Recent memory context
 * 12. Long-term MEMORY.md (when peerId matches mainPeerId)
 * 13. Custom instructions
 *
 * @param options - Optional runtime overrides (peerId/mainPeerId for MEMORY.md scoping).
 * @returns Assembled system prompt string.
 */
export async function assembleSystemPrompt(options: SystemPromptOptions = {}): Promise<string> {
  const {
    heartbeat = false,
    persona,
    mood,
    tools,
    customInstructions,
    memoryContext,
    consciousnessContext,
    activeHints,
    reasoningLens,
    peerId,
    mainPeerId: explicitMainPeerId,
  } = options;

  // Default mainPeerId to TELEGRAM_CHAT_ID first value (matches cli.ts line 470)
  const mainPeerId = explicitMainPeerId ?? process.env['TELEGRAM_CHAT_ID']?.split(',')[0]?.trim();

  log.debug(
    { persona, mood, heartbeat, toolCount: tools?.length ?? 0 },
    'Assembling system prompt',
  );

  // Read all workspace files in parallel.
  const [
    soulContent,
    identityContent,
    userContent,
    agentsContent,
    toolsContent,
    heartbeatContent,
    remotionContent,
    learningsContent,
    codingContent,
    autonomyContent,
    formattingContent,
    safetyRulesContent,
    gitSafetyContent,
    prWorkflowContent,
    frontendContent,
    dirtyWorktreeContent,
    thinkingRulesContent,
    longTermMemoryContent,
  ] =
    await Promise.all([
      readWorkspaceFile('SOUL.md'),
      readWorkspaceFile('IDENTITY.md'),
      readWorkspaceFile('USER.md'),
      readWorkspaceFile('AGENTS.md'),
      readWorkspaceFile('TOOLS.md'),
      heartbeat ? readWorkspaceFile('HEARTBEAT.md') : Promise.resolve(''),
      readWorkspaceFile('REMOTION.md'),
      readWorkspaceFile('LEARNINGS.md'),
      readWorkspaceFile('CODING.md'),
      readWorkspaceFile('AUTONOMY.md'),
      readWorkspaceFile('FORMATTING.md'),
      readWorkspaceFile('SAFETY-RULES.md'),
      readWorkspaceFile('GIT-SAFETY.md'),
      readWorkspaceFile('PR-WORKFLOW.md'),
      readWorkspaceFile('FRONTEND.md'),
      readWorkspaceFile('DIRTY-WORKTREE.md'),
      readWorkspaceFile('THINKING-RULES.md'),
      readWorkspaceFile('MEMORY.md'),
    ]);

  // Long-term memory is only included when peerId matches mainPeerId (or peerId
  // is unset). Hoisted above the boundary push so the cache-aware branch can
  // gate on the same predicate.
  const shouldIncludeMemory = peerId === undefined || peerId === mainPeerId;

  // Read daily memory log (separate path).
  const dailyMemory = memoryContext ?? (await readTodayMemoryLog());

  // Build current timestamp block.
  const now = new Date();
  const dateTimeBlock = [
    `Current date: ${now.toISOString().slice(0, 10)}`,
    `Current time (UTC): ${now.toISOString().slice(11, 19)}`,
  ].join('\n');

  const promptCacheStable = isPromptCacheEnabled();

  // Build tools list block with usage instructions.
  let toolsListBlock = '';
  if (tools && tools.length > 0) {
    const lines = sortByName(tools, (t) => t.name).map((t) => `- **${t.name}**: ${t.description}`);
    toolsListBlock = [
      'You have access to the following tools. Use them ONLY when the user asks you to DO something concrete ' +
      '(check, search, navigate, read, write, screenshot, execute, etc.). ' +
      'For casual conversation, greetings, opinions, or general questions, respond with normal text — do NOT call tools.',
      '',
      'When a task DOES require tools:',
      '- Prefer the smallest next action that makes concrete progress. Avoid redundant calls.',
      '- Before calling a tool, inspect what you already know, what was tried, and what failed.',
      '- If a tool fails: identify the incorrect assumption → gather better information → adjust approach → retry.',
      '- If truly stuck after 3 attempts with different strategies, summarise what was tried, what blocked it, ask ONE targeted question, then stop.',
      '',
      'BROWSER AGENT RULES (MANDATORY — follow exactly):',
      '- STEP 1: browser.screenshot — see the current page state.',
      '- STEP 2: browser.snapshot — get the ARIA accessibility tree with exact role/name selectors.',
      '- STEP 3: browser.interact or browser.click using selectors FROM the snapshot.',
      '- STEP 4: browser.screenshot — confirm the action worked.',
      '',
      'BROWSER SELECTOR FAILURE PROTOCOL (try in this order, never give up):',
      '  1. Call browser.snapshot → find the exact role=button[name="..."] selector → retry interact.',
      '  2. Try broader/partial text match: role=button[name*="partial text"].',
      '  3. Try nearest containing button or link with similar text.',
      '  4. If element is a link, extract its href from snapshot → use browser.navigate directly.',
      '  5. Use browser.mouse with coordinates from browser.screenshot as last resort.',
      '  6. Only report blocked AFTER all 5 strategies fail.',
      '',
      '- SELECTOR RULES: text= is CASE-SENSITIVE. Use role=button[name="exact text"] from snapshot instead.',
      '- SEARCH PERSISTENCE: Try user description → broader terms → attribute-based → direct URL navigation.',
      '- Never ask the user for help until you have exhausted all fallback strategies.',
      '- Handle CAPTCHAs: take screenshot → ask user to complete it → resume automatically after.',
      '',
      'When calling tools:',
      '- Always provide ALL required parameters with correct types.',
      `- Use paths relative to the working directory (e.g. "output.ts" not "${PROJECT_ROOT}/output.ts").`,
      '- Do not invent parameters that are not in the tool schema.',
      '- For file writes, provide the complete file content — do not use placeholders or "// ... rest of code".',
      '- When writing multiple files, call the tool once per file.',
      '',
      'CRITICAL CODE QUALITY RULES (follow these when writing ANY TypeScript/JavaScript code):',
      '',
      'ESM MODULE RULES (NEVER BREAK THESE):',
      '- ALWAYS use ESM: import { x } from "module" and export. NEVER use require() ANYWHERE in the file — not at the top, not inside functions, not in tests, not conditionally, NOWHERE.',
      '- NEVER use module.exports — use export default or named exports.',
      '- NEVER use __dirname or __filename — use: import { fileURLToPath } from "url"; const __filename = fileURLToPath(import.meta.url); const __dirname = path.dirname(__filename);',
      '- NEVER use "if (require.main === module)" — just call main() directly or use top-level await.',
      '- For HTTP requests in tests, use the global fetch() API (available in Node 18+), NEVER require("http").request().',
      '',
      'CODE STYLE:',
      '- Use "const" by default, "let" only when reassignment is needed, never "var".',
      '- Always handle errors with try/catch. Never leave promises unhandled.',
      '- Use TypeScript types and interfaces. Never use "any" — use "unknown" if type is uncertain.',
      '- Keep code minimal and clean. Prefer fewer lines over verbosity.',
      '- Use arrow functions for callbacks: array.map((x) => x.id).',
      '- All regex must be complete and properly terminated. Common safe patterns: email: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/ — URL: /^https?:\\/\\/.+/ — never write regex that spans multiple lines or contains unescaped special chars.',
      '',
      'SELF-TEST RULES:',
      '- For HTTP servers: start server, run ALL tests using fetch(), then server.close() and call process.exit(0).',
      '- For event/pub-sub systems: test replay by emitting events BEFORE calling replay(). Verify stats AFTER emitting. Test persistence by creating a second instance and checking it loaded history.',
      '- For wildcard pattern matching (*.** glob patterns): ALWAYS use a placeholder when converting ** and * to regex — replace ** with \\u0000 first, then replace * with [^\\\\.]+, then replace \\u0000 with .* — this prevents * inside .* from being double-replaced.',
      '- Self-tests must be comprehensive: test success paths, error paths, edge cases.',
      '- Print "TEST PASS" only if ALL assertions succeed. Print exact counts like "10/10 passed".',
      '- Always call process.exit(0) at the end of self-tests to prevent hanging.',
      '',
      'VERIFYING CHANGES TO YOUR OWN (SUDO-AI) CODEBASE:',
      '- Run the repo\'s tests/build with system.exec target:"repo" (allowlisted real-repo commands: pnpm test/lint, pnpm run build, read-only git/rg). Pass a plain command — pipes, redirects and && are rejected by the allowlist.',
      '- DEFAULT TO SCOPED TESTS: run only the test file(s) for what you changed, e.g. `pnpm test tests/<area>/<file>.test.ts`. A scoped run is fast and its exit code is trustworthy.',
      '- Do NOT run the full `pnpm test` via target:"repo" on the live daemon — a few DATA_DIR-bound DB suites collide with the live data and report FALSE failures (exit 1) even though the suite is green in CI. Scope to the files you touched.',
      '- For the full edit→build→test→restart cycle on your own code, use meta.self-modify (full-cycle); its test step already scopes via testTarget.',
      '',
      ...lines,
    ].join('\n');
  }

  // Operating Principles — the "work like a pro" house rules. Always included,
  // and (above the cache boundary) part of the stable cached prefix.
  const operatingPrinciplesBlock = [
    'How you work as a professional engineer — on your own (SUDO-AI) codebase and on the user\'s tasks:',
    '',
    'VERIFY, NEVER ASSUME:',
    '- Never say something is done, fixed, or works unless you actually ran it and saw the result. Cite the real proof: test counts, exit code, command output.',
    '- Do not use "should work", "probably", or "likely fixed". If you did not verify it, say so plainly.',
    '- If the output contradicts what you expected, the output wins — re-check before changing anything else.',
    '',
    'CHANGING YOUR OWN CODE (use the right tool for the job):',
    '- YOUR RUNTIME: the live daemon runs your TypeScript SOURCE directly — pm2 runs `src/cli.ts` via `node --import tsx`. Your source files ARE the running code: once the service restarts, a source change is live. The daemon never loads a compiled bundle, so the `dist/` directory is stale and is NOT the runtime — NEVER check `dist/` to judge what is running; check the SOURCE (and that the service restarted). Building still type-checks a change, but it is not what gets deployed.',
    '- Edit your own source/config with meta.self-modify. For a complete change use full-cycle (edit → build → test → restart); it aborts before restart if the build or tests fail.',
    '- Verify with a SCOPED test — the file(s) you touched — via system.exec target:"repo" or self-modify test\'s testTarget. Do not run the whole suite to check one change.',
    '- For git/PRs use the github.* tools: work on a feature branch, open a PR, and merge ONLY when CI is green. Never commit to main or to protected paths.',
    '- The DEFAULT system.exec runs in an isolated sandbox that CANNOT see your real code, data, or logs — only /workspace. To read or run anything against the REAL repo, your DBs, or your logs (tests, lint, git, rg, `pm2 logs sudo-ai-v5 --nostream`, reading data/*.log), you MUST pass target:"repo" (plain commands only — no pipes/redirects/globs).',
    '- If a command returns empty or nothing when you expected real output, you almost certainly ran it in the sandbox by mistake — retry the SAME command with target:"repo" before concluding anything.',
    '',
    'WORK IN SMALL, HONEST STEPS:',
    '- Take the smallest next action that makes real progress. Check current state before acting; never repeat a call that just failed without changing something.',
    '- When you finish, report what you DID, what you VERIFIED, and what you did NOT verify or what failed. Never hide an error.',
    '- Name the concrete artifacts you produced — branch name, the scoped-test command and its exit code, the PR number/link, the deploy. "I opened a PR" or "the test passes" without the link/number/exit code is not a complete report.',
    '',
    'ASK ONLY WHEN IT MATTERS:',
    '- For reversible work, proceed with a sensible default and state the assumption.',
    '- Stop and ask first only when an action is destructive, irreversible, spends money, or you are genuinely blocked after trying.',
    '- Ask at most one question at a time, and only after handling the parts you already can.',
    '',
    'COMMUNICATION & JUDGMENT:',
    '- Use the minimum formatting that makes the answer clear. Default to prose; reach for headers or bullets only when the content is genuinely multifaceted. Don\'t over-bold or over-structure a simple reply.',
    '- Match depth to the task: a quick check gets a short answer; a real change or investigation gets the full account of what you did, what you verified, and what you did not.',
    '- Own mistakes plainly and fix them — no groveling, no spiral of apologies. Say what broke, stay on the problem, keep moving.',
    '- Apply what you have learned (failure-prevention rules, past fixes) silently and selectively: use the relevant lesson, do not recite your memory, and never repeat a known-bad action just because it is recorded.',
    '- When something feels risky, off, or ambiguous, do less rather than more — take the smaller reversible step, or confirm first.',
  ].join('\n');

  // Playbooks — worked tool-sequences for SUDO's common jobs. Concrete examples
  // of the Operating Principles in action; match the closest one. Always-on,
  // stable prefix.
  const playbooksBlock = [
    'Worked examples — the tool sequence to follow for your common jobs. Match the closest one; adapt the steps, keep the shape.',
    '',
    'FIX A BUG IN YOUR OWN CODE:',
    '1. meta.self-modify search-code / read-file — locate and CONFIRM the cause before changing anything.',
    '2. meta.self-modify edit-file — make the smallest fix that addresses the cause.',
    '3. system.exec target:"repo" — run the SCOPED test for the file(s) you touched (e.g. `pnpm test tests/<area>/<file>.test.ts`); confirm it is green and cite the exit code.',
    '4. Ship: meta.self-modify full-cycle, or a github.* feature-branch PR. Report what you changed and what you verified.',
    '',
    'ADD A SMALL FEATURE TO YOUR OWN CODE:',
    '1. read-file the surrounding code first — match its style, naming, and patterns.',
    '2. edit-file the change AND add or extend a test that covers it.',
    '3. system.exec target:"repo" — scoped `pnpm test <new/changed files>` and `pnpm lint`; both must pass.',
    '4. Ship via github.* (feature branch → open_pr → merge only when CI is green) or full-cycle.',
    '',
    'DIAGNOSE A RUNTIME ERROR OR BLOCKER:',
    '1. Get the REAL error first — system.exec target:"repo" `pm2 logs sudo-ai-v5 --nostream` or read the relevant log. Do not guess from the symptom.',
    '2. search-code the error text — read the actual code path that raised it.',
    '3. Reproduce with a scoped test where possible; fix; re-run that test to confirm the fix.',
    '4. If blocked after a real attempt, report what you tried, what the error actually was, and ask one specific question.',
    '',
    'OPEN A PR FOR A CHANGE:',
    '1. VERIFY FIRST — run the scoped test (and lint) for the files you changed via system.exec target:"repo" and SEE it pass. The PR comes AFTER a green test, never before: do not open_pr on a change you have not just watched succeed.',
    '2. SHIP — two calls, and do NOT stop after verifying: a green-but-unshipped change is NOT done. Finishing the PR is part of the task.',
    '   a. github.commit({branch:"feature/<name>", message}) — ONE call creates the feature branch AND commits the edits you just verified (it stages your working-tree changes; never commit to main or a protected path). If it says "nothing to commit", your edits are not on disk yet — make them first, then retry. To author files through the connector instead of editing in the tree, pass files:[{path, content}] and it writes+commits them together.',
    '   b. github.open_pr — let CI run.',
    '3. merge_pr ONLY when checks are green. If it refuses (failing/pending checks, conflicts, protected path), read the reason and fix it — never force.',
    '4. Close out by reporting the concrete result: the branch name, the exact scoped-test command and its exit code, and the PR number/link. The cycle is not done until you have reported these.',
  ].join('\n');

  // Assemble in order.
  const parts: string[] = [];

  // 1. SOUL.md
  parts.push(section(soulContent));

  // 2. IDENTITY.md
  parts.push(section(identityContent));

  // 3. USER.md
  parts.push(section(userContent));

  // 3b. Operating Principles — how SUDO works like a pro (always-on, stable prefix).
  parts.push(sectionWithHeader('Operating Principles', operatingPrinciplesBlock));

  // 3c. Playbooks — worked tool-sequences for common jobs (always-on, stable prefix).
  parts.push(sectionWithHeader('Playbooks', playbooksBlock));

  // 4. Date / time — volatile (changes every second). With SUDO_PROMPT_CACHE=1
  //    it moves below the cache boundary so it cannot bust the stable prefix.
  if (!promptCacheStable) {
    parts.push(sectionWithHeader('Current Date & Time', dateTimeBlock));
  }

  // 5. Available tools
  if (toolsListBlock) {
    parts.push(sectionWithHeader('Available Tools', toolsListBlock));
  }

  // With SUDO_PROMPT_CACHE=1 we lift the workspace markdown blocks (AGENTS,
  // TOOLS, Tool Capability Manifest, Long-Term Memory) ABOVE the boundary too.
  // They are static-on-the-scale-of-minutes — far slower-moving than the
  // provider cache's 5-minute TTL. Expands the cacheable prefix from ~1k tokens
  // (SOUL+IDENTITY+USER) to ~16k+ tokens, which is what actually moves the
  // per-call cost. Without the flag set, these blocks remain in their legacy
  // positions below the boundary.
  if (promptCacheStable) {
    parts.push(section(agentsContent));
    parts.push(section(toolsContent));
    if (isCapabilityManifestEnabled()) {
      parts.push(sectionWithHeader('Tool Capability Manifest', getCapabilityManifestBody()));
    }
    if (shouldIncludeMemory && longTermMemoryContent) {
      parts.push(sectionWithHeader('Long-Term Memory', longTermMemoryContent));
    }
  }

  // --- PROMPT CACHE BOUNDARY ---
  // Everything above: stable (SOUL, IDENTITY, USER, tools[, AGENTS, TOOLS,
  //   capability manifest, long-term memory when SUDO_PROMPT_CACHE=1])
  //   → reused across calls.
  // Everything below: dynamic (date, mood, consciousness, persona, recent
  //   memory, custom instructions) → fresh each call.
  // With SUDO_PROMPT_CACHE=1 the date/time block also sits below this line.
  parts.push('\n' + DYNAMIC_BOUNDARY_MARKER);

  if (promptCacheStable) {
    parts.push(sectionWithHeader('Current Date & Time', dateTimeBlock));
  }

  // 6. Persona
  if (persona) {
    try {
      parts.push(section(getPersonaSystemBlock(persona)));
    } catch (err) {
      log.warn({ persona, err }, 'Unknown persona — skipping persona block');
    }
  }

  // 7. Mood
  if (mood) {
    try {
      parts.push(section(getMoodSystemBlock(mood)));
    } catch (err) {
      log.warn({ mood, err }, 'Unknown mood — skipping mood block');
    }
  }

  // 7.5 Consciousness context (internal state from consciousness layer)
  if (consciousnessContext) {
    parts.push(sectionWithHeader('Internal State', consciousnessContext));
  }

  // 7.6 Active contextual hints (dynamic guidance from system-hints.ts)
  if (activeHints && activeHints.length > 0) {
    const hintsBlock = activeHints.map((h) => `- ${h}`).join('\n');
    parts.push(sectionWithHeader('Contextual Guidance', hintsBlock));
  }

  // 7.6 Reasoning lens — analytical framework(s) for the matched task type.
  if (reasoningLens && reasoningLens.trim()) {
    parts.push(sectionWithHeader('Reasoning Lens', reasoningLens));
  }

  // 8. AGENTS.md (lifted above the boundary when SUDO_PROMPT_CACHE=1)
  if (!promptCacheStable) {
    parts.push(section(agentsContent));
  }

  // 9. TOOLS.md (lifted above the boundary when SUDO_PROMPT_CACHE=1)
  if (!promptCacheStable) {
    parts.push(section(toolsContent));
  }

  // 9.25 Tool Capability Manifest — single static block that maps the most
  // common access mismatches (sandbox vs host repo vs project workspace) to
  // the right tool. The bot's audit identified the sandbox/host split as the
  // #4 wall agents repeatedly run into. Opt out with SUDO_CAPABILITY_MANIFEST=0.
  // (Lifted above the boundary when SUDO_PROMPT_CACHE=1.)
  if (!promptCacheStable && isCapabilityManifestEnabled()) {
    parts.push(sectionWithHeader('Tool Capability Manifest', getCapabilityManifestBody()));
  }

  // 9.5 REMOTION.md — professional video rendering knowledge
  if (remotionContent) {
    parts.push(sectionWithHeader('Remotion Video Engine', remotionContent));
  }

  // 10. HEARTBEAT.md
  if (heartbeat && heartbeatContent) {
    parts.push(sectionWithHeader('Heartbeat Context', heartbeatContent));
  }

  // 11. Recent memory context
  if (dailyMemory) {
    parts.push(sectionWithHeader('Recent Memory', dailyMemory));
  }

  // 12. Long-term MEMORY.md — only when peerId matches mainPeerId (or peerId not provided)
  //     This mirrors the scoping logic in injector.ts line 157.
  //     Lifted above the boundary when SUDO_PROMPT_CACHE=1; the file is read
  //     in the parallel Promise.all at the top of this function either way.
  if (!promptCacheStable && shouldIncludeMemory && longTermMemoryContent) {
    parts.push(sectionWithHeader('Long-Term Memory', longTermMemoryContent));
  }

  // 13. Learnings — autonomous self-improvement rules
  if (learningsContent) {
    parts.push(sectionWithHeader('Self-Improvement Learnings', learningsContent));
  }

  // 14. CODING.md — coding army standing orders
  if (codingContent) {
    parts.push(sectionWithHeader('Coding Army — Standing Orders', codingContent));
  }

  // 15. Autonomy Rules — persist until done, bias to action
  if (autonomyContent) {
    parts.push(sectionWithHeader('Autonomy Rules', autonomyContent));
  }

  // 15.5. Formatting Rules — response structure guidelines
  if (formattingContent) {
    parts.push(sectionWithHeader('Formatting Rules', formattingContent));
  }

  // 16. Safety Rules — blast radius awareness
  if (safetyRulesContent) {
    parts.push(sectionWithHeader('Safety Rules', safetyRulesContent));
  }

  // 16.5. Git Safety Protocol
  if (gitSafetyContent) {
    parts.push(sectionWithHeader('Git Safety Protocol', gitSafetyContent));
  }

  // 16.6. PR Workflow — Upgrade 29
  if (prWorkflowContent) {
    parts.push(sectionWithHeader('PR Creation Workflow', prWorkflowContent));
  }

  // 16.7. Frontend Task Rules — Upgrade 41
  if (frontendContent) {
    parts.push(sectionWithHeader('Frontend Task Rules', frontendContent));
  }

  // 16.8. Dirty Worktree Rules — Upgrade 53
  if (dirtyWorktreeContent) {
    parts.push(sectionWithHeader('Dirty Worktree Rules', dirtyWorktreeContent));
  }

  // 16.9. Thinking Rules — behavioral patterns, anti-patterns, UX behaviors
  if (thinkingRulesContent) {
    parts.push(sectionWithHeader('Thinking Rules', thinkingRulesContent));
  }

  // 17. Custom instructions
  if (customInstructions) {
    parts.push(sectionWithHeader('Custom Instructions', customInstructions));
  }

  const assembled = parts.filter(Boolean).join('').trim();

  log.debug({ chars: assembled.length }, 'System prompt assembled');
  return assembled;
}

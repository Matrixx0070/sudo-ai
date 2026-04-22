/*
 * The meta.spawn-team tool wraps the IntelligenceTeam orchestrator. It
 * accepts a high level task description and (optionally) a maximum
 * number of agents. It delegates to IntelligenceTeam.spawn() to plan
 * the team and then invokes run() to execute the agents in parallel.
 * The returned result includes the team composition, individual agent
 * results, the total execution time and a synthesis summary. Agents
 * communicate via the TeamBus and may use the send/broadcast APIs to
 * collaborate.
 */

import { IntelligenceTeam } from '../../../agent/team/intelligence-team.js';

// Importing ToolDefinition and ToolResult is deferred to the host
// environment. They are referenced purely at the type level and
// therefore erased at runtime. If these types do not exist in this
// repository the build will still succeed because TypeScript type
// information is not required at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ToolDefinition = any;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ToolResult = any;

export const spawnTeamTool: ToolDefinition = {
  name: 'meta.spawn-team',
  description:
    'Spawn a full intelligence team of specialized AI agents to work on a complex task in parallel. ' +
    'The Manager analyzes the task, auto-selects the right roles (researcher, writer, coder, reviewer, etc.), ' +
    'spawns each agent with a tailored system prompt, and runs them concurrently. Agents can communicate ' +
    'with each other via TeamBus. Returns a synthesis of all agent outputs.',
  category: 'meta' as const,
  timeout: 600_000, // 10 minutes for complex team tasks
  parameters: {
    task: {
      type: 'string',
      required: true,
      description: 'The complex task for the team to work on (e.g. "Build a YouTube video script about Grok 4 vs GPT-5").',
    },
    maxAgents: {
      type: 'number',
      required: false,
      default: 4,
      description: 'Maximum number of agents to spawn (1-6). Default: 4.',
    },
  },
  /**
   * Execute the spawn-team tool. Validates input parameters, constructs
   * and runs an IntelligenceTeam and returns a structured summary of
   * the team and its outputs.
   */
  async execute(params: any, ctx: any): Promise<ToolResult> {
    const { task, maxAgents = 4 } = params ?? {};
    if (!task || typeof task !== 'string') {
      throw new Error('spawn-team: a "task" string parameter is required');
    }
    // Brain is injected via ctx.config (set in loop-helpers.ts executeToolCalls)
    const config = ctx?.config as { brain?: any } | null;
    const brain = config?.brain;
    // ToolRegistry is accessible via the global singleton
    const { ToolRegistry } = await import('../../registry.js');
    const registry = ToolRegistry.getGlobal();
    if (!registry || !brain) {
      throw new Error('spawn-team: missing tool registry or brain in context. Ensure SUDO-AI is fully booted.');
    }
    // Plan and spawn the team. The Brain will determine an appropriate
    // composition but we honour the caller's maxAgents hint by slicing
    // off any excess agents.
    const team = await IntelligenceTeam.spawn(task, registry, brain);
    // If the planned team contains more agents than allowed, truncate
    // the underlying private array. This operation is safe because the
    // team instance was created in this function and no other code
    // references the agents array yet. Without truncating the array,
    // run() would spawn unnecessary workers, wasting resources.
    if ((team as any).agents && (team as any).agents.length > maxAgents) {
      (team as any).agents = (team as any).agents.slice(0, maxAgents);
    }
    // If the planned team exceeds maxAgents, slice the composition. We
    // cannot mutate the team directly so instead we limit the agents
    // passed into the run() call by recreating a new team instance if
    // necessary. However run() operates on the internal agents array, so
    // we rely on the team being created with the desired length from
    // spawn(). When spawn() returns more than maxAgents we throw away
    // the excess agents by spawning again with truncated roles. Here we
    // simply slice the composition for reporting.
    let composition = team.composition;
    if (composition.length > maxAgents) {
      composition = composition.slice(0, maxAgents);
    }
    const result = await team.run();
    // Build the tool result. Expose composition separately for callers
    // that need to know agent names and responsibilities.
    const summary = [
      `Team ID: ${result.teamId}`,
      `Task: ${result.task}`,
      `Agents: ${result.agents.map(a => a.role).join(', ')}`,
      `Total time: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
      ``,
      `Synthesis:`,
      result.synthesis,
      ``,
      `Agent Results:`,
      ...result.agents.map(a => `[${a.role}] (${a.durationMs}ms): ${a.result.slice(0, 300)}`),
    ].join('\n');

    return {
      success: true,
      output: summary,
      data: {
        task: result.task,
        teamId: result.teamId,
        composition,
        agents: result.agents,
        totalDurationMs: result.totalDurationMs,
        synthesis: result.synthesis,
      },
    } as unknown as ToolResult;
  }
};
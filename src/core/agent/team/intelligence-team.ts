/*
 * IntelligenceTeam orchestrates a group of autonomous agents to
 * collaboratively execute a complex task. The team is dynamically
 * assembled by calling the Brain to plan the appropriate number of
 * specialized agents and their roles. Each agent is executed in its
 * own worker thread and communicates through a shared TeamBus. The
 * Brain is only invoked from the main thread; workers request
 * Brain completions via parentPort messages to ensure isolation and
 * that secrets or network configuration are never leaked across
 * threads. Results from all agents are collated into a TeamResult
 * along with a synthesis summary.
 */

import { EventEmitter } from 'events';
import { Worker, MessageChannel, isMainThread, parentPort, workerData } from 'worker_threads';
import { TeamBus } from './team-bus.js';
import type { BrainMessage } from '../../brain/types.js';

// -----------------------------------------------------------------------------
// Type declarations
//
// These interfaces define the shape of the data structures exchanged
// throughout the team. They mirror the definitions provided in the
// specification. Because the wider system defines ToolRegistry, Brain and
// ToolResult elsewhere, we import them as types but do not implement them
// here. Any consumer of this module must supply compatible objects.

/** A description of a single agent's responsibilities. */
export interface AgentRole {
  name: string;
  systemPrompt: string;
  task: string;
  fileBoundaries: string[];
  teammates: string[];
}

/**
 * The status of an individual agent. When status is 'running' the
 * startTime will be defined. On completion or failure the endTime will
 * also be set. If the agent fails, an error message may be present.
 */
export interface AgentStatus {
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  error?: string;
}

/** A map of agent names to their current statuses. */
export type TeamStatus = Record<string, AgentStatus>;

/**
 * Discriminated union of messages a worker thread can post back to the
 * main thread over `parentPort`. The worker script is generated as a
 * template-literal in {@link IntelligenceTeam.run} — the three `type`
 * variants below pin the contract.
 *
 * `brainRequest` originates worker→main and triggers a main→worker
 * `{ type: 'brainResponse', id, result | error }` reply; the reply
 * shape lives on the main thread side only and is intentionally NOT
 * part of this union.
 */
type WorkerToMainMessage =
  | { type: 'brainRequest'; id: number; messages: BrainMessage[] }
  | { type: 'result'; result?: unknown }
  | { type: 'error'; error?: unknown };

/**
 * The result returned when the team finishes. Each agent's output
 * includes its role name, the produced result and duration in
 * milliseconds. The synthesis contains a manager's summary.
 */
export interface TeamResult {
  teamId: string;
  task: string;
  agents: Array<{ role: string; result: string; durationMs: number }>;
  totalDurationMs: number;
  synthesis: string;
}

// Because Brain and ToolRegistry are provided by the outer system, we
// reference them only as types. They must supply a call() method and any
// other behaviour used by the agents. ToolRegistry is passed through to
// workers but is never cloned across threads.
export interface Brain {
  call(
    args: { messages: Array<{ role: string; content: string }> },
    // Optional tier hint matches the real Brain.call signature so callers
    // here can pass `{ tier: 'high-stakes' }` and opt into the env-driven
    // strategy upgrade from PR #242. Existing minimal mocks without the
    // opts arg still satisfy this contract structurally.
    opts?: { tier?: 'fast' | 'routine' | 'high-stakes' },
  ): Promise<{ content: string }>;
}
export interface ToolRegistry {}

// Utility to generate unique identifiers without introducing an external
// dependency. Node 18+ exposes crypto.randomUUID() which returns a
// RFC‑4122 compliant UUID. Fall back to a simple timestamp string if
// crypto.randomUUID is unavailable.
function generateId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `team-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * IntelligenceTeam coordinates a set of agents working in parallel to
 * complete a given task. The spawn() factory analyses the task via
 * Brain to decide on an optimal team composition. Instances created
 * through spawn() are ready to be run via run().
 */
export class IntelligenceTeam {
  private readonly teamId: string;
  private readonly task: string;
  private readonly registry: ToolRegistry;
  private readonly brain: Brain;
  private readonly bus: TeamBus;
  private readonly agents: AgentRole[];
  private readonly statuses: TeamStatus;

  private constructor(task: string, agents: AgentRole[], registry: ToolRegistry, brain: Brain) {
    this.teamId = generateId();
    this.task = task;
    this.agents = agents;
    this.registry = registry;
    this.brain = brain;
    this.bus = new TeamBus();
    // Initialise all statuses to pending
    this.statuses = {};
    for (const agent of agents) {
      this.statuses[agent.name] = { status: 'pending' };
    }
  }

  /**
   * Returns a copy of the underlying agent definitions. Exposing this
   * accessor avoids leaking the private agents array while still
   * permitting callers (such as tools) to inspect the planned team
   * composition.
   */
  get composition(): AgentRole[] {
    return this.agents.map(a => ({ ...a }));
  }

  /**
   * spawn constructs a new IntelligenceTeam by asking the Brain to
   * determine how many agents are needed and what roles they should
   * have. The Brain receives a carefully crafted prompt instructing it
   * to output a JSON array describing each agent. If parsing fails or
   * the LLM response is unusable, a fallback single agent is created.
   */
  static async spawn(task: string, registry: ToolRegistry, brain: Brain): Promise<IntelligenceTeam> {
    // Compose a system prompt asking the Brain to plan the team. We
    // instruct the model to output strict JSON to make parsing
    // straightforward. The model is asked to choose between 1 and 6
    // agents and to provide file boundaries and teammate names.
    const systemPrompt = [
      'You are an expert multi‑agent planner.',
      'Given a complex user task you must decide on an appropriate team of AI agents to perform that task.',
      'Choose between 1 and 6 agents. For each agent output an object with the following keys:',
      ' - name: a short, descriptive noun for the role (e.g. "researcher", "writer").',
      ' - systemPrompt: a complete persona prompt explaining the persona and instructions for that agent.',
      ' - task: the specific deliverable or subtask this agent is responsible for.',
      ' - fileBoundaries: an array of file paths that this agent will own.',
      ' - teammates: an array of the names of the other agents.',
      'Respond only with a valid JSON array of agent objects and no surrounding commentary.'
    ].join('\n');
    const planningMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Task: ${task}` }
    ];
    let agentRoles: AgentRole[] = [];
    try {
      // tier: 'high-stakes' — team planning is one-shot per IntelligenceTeam
      // spawn; a wrong agent-role decomposition derails every worker spawned
      // below. Opts into the env-driven strategy upgrade from PR #242.
      const response = await brain.call({ messages: planningMessages }, { tier: 'high-stakes' });
      const trimmed = (response && response.content) ? response.content.trim() : '';
      // Attempt to parse the LLM response as JSON. Guard against trailing
      // characters by trimming common code fences.
      const jsonString = trimmed
        .replace(/^```json/i, '')
        .replace(/^```/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      const parsed: unknown = JSON.parse(jsonString);
      if (Array.isArray(parsed)) {
        agentRoles = parsed.map((raw: unknown): AgentRole => {
          const item = (raw ?? {}) as Record<string, unknown>;
          return {
            name: String(item.name),
            systemPrompt: String(item.systemPrompt),
            task: String(item.task),
            fileBoundaries: Array.isArray(item.fileBoundaries) ? item.fileBoundaries.map(String) : [],
            teammates: Array.isArray(item.teammates) ? item.teammates.map(String) : [],
          };
        });
      }
    } catch (err) {
      // Parsing failed; fallback to single agent below.
    }
    // If parsing failed or no agents returned, create a default single agent
    if (!agentRoles || agentRoles.length === 0) {
      agentRoles = [
        {
          name: 'generalist',
          systemPrompt: 'You are a versatile AI agent. Perform the assigned task to the best of your ability.',
          task: task,
          fileBoundaries: [],
          teammates: []
        }
      ];
    }
    return new IntelligenceTeam(task, agentRoles, registry, brain);
  }

  /**
   * run executes all agents concurrently using worker threads. Each
   * agent gets its own context and can communicate through the TeamBus.
   * Workers request Brain completions from the main thread via
   * message passing. A per‑agent timeout (default five minutes) ensures
   * that runaway agents do not stall the entire team. When all
   * agents complete or time out, a TeamResult is resolved.
   */
  async run(): Promise<TeamResult> {
    const agentCount = this.agents.length;
    const results: Array<{ role: string; result: string; durationMs: number }> = [];
    const startTime = Date.now();
    const workers: Worker[] = [];

    // Keep track of unresolved agents for final resolution
    let unresolved = agentCount;
    // Promises for each worker's completion
    const completionPromises: Promise<void>[] = [];

    // Handler for worker messages common to all workers
    const handleWorkerMessage = async (worker: Worker, agent: AgentRole, raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const msg = raw as WorkerToMainMessage;
      switch (msg.type) {
        case 'brainRequest': {
          const { id, messages } = msg;
          // Forward the completion request to the Brain and respond
          try {
            const result = await this.brain.call({ messages });
            worker.postMessage({ type: 'brainResponse', id, result });
          } catch (err: unknown) {
            const errMessage = err instanceof Error ? err.message : String(err);
            worker.postMessage({ type: 'brainResponse', id, error: errMessage });
          }
          break;
        }
        case 'result': {
          // Agent produced its final result; record and update status
          const end = Date.now();
          const status = this.statuses[agent.name];
          status.status = 'completed';
          status.endTime = end;
          results.push({ role: agent.name, result: String(msg.result ?? ''), durationMs: end - (status.startTime ?? startTime) });
          unresolved -= 1;
          break;
        }
        case 'error': {
          // Agent encountered an error; mark as failed
          const end = Date.now();
          const status = this.statuses[agent.name];
          status.status = 'failed';
          status.endTime = end;
          status.error = String(msg.error ?? 'Unknown worker error');
          results.push({ role: agent.name, result: '', durationMs: end - (status.startTime ?? startTime) });
          unresolved -= 1;
          break;
        }
        default:
          // Unknown message types are ignored silently
          break;
      }
    };

    // Create and launch a worker for each agent
    for (const agent of this.agents) {
      // Prepare a dedicated MessageChannel for this agent's bus communication
      const { port1, port2 } = new MessageChannel();
      // Register the agent's port with the bus. port2 stays in main thread.
      this.bus.registerAgent(agent.name, port2);

      // Mark the agent as running and record start time
      this.statuses[agent.name] = { status: 'running', startTime: Date.now() };

      // Compose the worker script. We embed a small module that sets up
      // bus communication, brain request handling and the agent loop.
      const workerScript = `import { parentPort, workerData } from 'worker_threads';\n` +
        `/* Worker entry point for agent ${agent.name}.\n` +
        `   This code is executed in its own thread with access to its bus\n` +
        `   MessagePort and agent description. It never imports the full\n` +
        `   IntelligenceTeam to avoid code bloat. */\n` +
        `const agent = workerData.agent;\n` +
        `const busPort = workerData.busPort;\n` +
        `// Maintain pending responses for bus reads\n` +
        `const pendingBus = new Map();\n` +
        `let nextBusId = 0;\n` +
        `// Maintain pending responses for brain requests\n` +
        `const pendingBrain = new Map();\n` +
        `let nextBrainId = 0;\n` +
        `// Handle messages from parent (main thread)\n` +
        `parentPort.on('message', (msg) => {\n` +
        `  if (!msg || typeof msg !== 'object') return;\n` +
        `  if (msg.type === 'brainResponse') {\n` +
        `    const { id, result, error } = msg;\n` +
        `    const resolver = pendingBrain.get(id);\n` +
        `    if (resolver) {\n` +
        `      pendingBrain.delete(id);\n` +
        `      if (error) resolver.reject(error);\n` +
        `      else resolver.resolve(result);\n` +
        `    }\n` +
        `  }\n` +
        `});\n` +
        `// Handle messages from bus (TeamBus)\n` +
        `busPort.on('message', (msg) => {\n` +
        `  if (!msg || typeof msg !== 'object') return;\n` +
        `  if (msg.type === 'response') {\n` +
        `    const { id, value } = msg;\n` +
        `    const resolver = pendingBus.get(id);\n` +
        `    if (resolver) { pendingBus.delete(id); resolver(value); }\n` +
        `  } else if (msg.type === 'message') {\n` +
        `    // In a real agent this could trigger behaviour; for now messages\n` +
        `    // are ignored.\n` +
        `  } else if (msg.type === 'share') {\n` +
        `    // Share updates can be handled similarly if needed.\n` +
        `  }\n` +
        `});\n` +
        `// Helper to perform a brain call via parent.\n` +
        `function callBrain(messages) {\n` +
        `  return new Promise((resolve, reject) => {\n` +
        `    const id = nextBrainId++;\n` +
        `    pendingBrain.set(id, { resolve, reject });\n` +
        `    parentPort.postMessage({ type: 'brainRequest', id, messages });\n` +
        `  });\n` +
        `}\n` +
        `// Helpers for bus operations\n` +
        `function busSend(to, content) { busPort.postMessage({ action: 'send', to, content }); }\n` +
        `function busBroadcast(content) { busPort.postMessage({ action: 'broadcast', content }); }\n` +
        `function busShare(key, value) { busPort.postMessage({ action: 'share', key, value }); }\n` +
        `function busRead(key) { return new Promise((resolve) => { const id = nextBusId++; pendingBus.set(id, resolve); busPort.postMessage({ id, action: 'read', key }); }); }\n` +
        `function busReadInbox() { return new Promise((resolve) => { const id = nextBusId++; pendingBus.set(id, resolve); busPort.postMessage({ id, action: 'readInbox' }); }); }\n` +
        `// Main async function executed by the worker.\n` +
        `async function agentLoop() {\n` +
        `  try {\n` +
        `    // Compose messages for the Brain. The first message is the\n` +
        `    // agent's persona/system prompt, followed by the specific task.\n` +
        `    const messages = [\n` +
        `      { role: 'system', content: agent.systemPrompt },\n` +
        `      { role: 'user', content: agent.task }\n` +
        `    ];\n` +
        `    const response = await callBrain(messages);\n` +
        `    // The response is expected to be an object with a content field\n` +
        `    // containing the agent's final output.\n` +
        `    parentPort.postMessage({ type: 'result', result: response.content ?? '' });\n` +
        `  } catch (err) {\n` +
        `    parentPort.postMessage({ type: 'error', error: err?.message ?? String(err) });\n` +
        `  }\n` +
        `}\n` +
        `agentLoop();\n`;

      // Spawn the worker. The workerData includes the agent definition
      // and its bus port. The bus port must be transferred to give the
      // worker full ownership; otherwise it would remain unusable in
      // the worker.
      const worker = new Worker(workerScript, {
        eval: true,
        workerData: { agent, busPort: port1 },
        transferList: [port1],
      });
      workers.push(worker);
      // Listen for messages from this worker
      worker.on('message', (msg) => handleWorkerMessage(worker, agent, msg));
      worker.on('error', (err) => {
        // Worker emitted an uncaught exception; mark as failed
        const status = this.statuses[agent.name];
        status.status = 'failed';
        status.endTime = Date.now();
        status.error = (err as Error)?.message ?? String(err);
        unresolved -= 1;
      });
      worker.on('exit', (code) => {
        // If the worker exits without sending a result or error, mark as failed
        const status = this.statuses[agent.name];
        if (status.status === 'running') {
          status.status = code === 0 ? 'completed' : 'failed';
          status.endTime = Date.now();
          results.push({ role: agent.name, result: '', durationMs: status.endTime - (status.startTime ?? startTime) });
          unresolved -= 1;
        }
      });
      // Set up a timeout to terminate runaway agents
      const timeoutMs = 5 * 60 * 1000; // 5 minutes
      const timer = setTimeout(() => {
        if (this.statuses[agent.name].status === 'running') {
          // Terminate the worker and mark as failed
          worker.terminate();
          const status = this.statuses[agent.name];
          status.status = 'failed';
          status.endTime = Date.now();
          status.error = 'Timed out';
          results.push({ role: agent.name, result: '', durationMs: status.endTime - (status.startTime ?? startTime) });
          unresolved -= 1;
        }
      }, timeoutMs);
      // Ensure timer is cleared once the worker resolves
      completionPromises.push(new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.statuses[agent.name].status !== 'running') {
            clearTimeout(timer);
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      }));
    }

    // Wait for all workers to finish or fail
    await Promise.all(completionPromises);

    const totalDurationMs = Date.now() - startTime;
    // Determine a synthesis of all agent results. If there is a role
    // containing 'manager' or 'lead', pick its result as the synthesis.
    let synthesis = '';
    const managerResult = results.find(r => /manager|lead/i.test(r.role));
    if (managerResult) {
      synthesis = managerResult.result;
    } else {
      // Fallback: call the brain with all agent results to summarise.
      // tier: 'high-stakes' — final synthesis is the user-facing answer
      // for the entire team task. A malformed synthesis loses every
      // worker's contribution. Opts into the env-driven strategy upgrade
      // from PR #242.
      try {
        const summaryMessages = [
          { role: 'system', content: 'You are a helpful assistant that synthesises multiple agent outputs into a coherent summary.' },
          { role: 'user', content: `Combine the following outputs into a concise summary:\n${results.map(r => `Role ${r.role}: ${r.result}`).join('\n')}` }
        ];
        const summaryResponse = await this.brain.call({ messages: summaryMessages }, { tier: 'high-stakes' });
        synthesis = summaryResponse.content;
      } catch (err) {
        synthesis = results.map(r => r.result).join('\n');
      }
    }

    return {
      teamId: this.teamId,
      task: this.task,
      agents: results,
      totalDurationMs,
      synthesis
    };
  }

  /**
   * Returns the current status of each agent in the team. This method can
   * be called at any time while the team is running to get live updates.
   */
  getStatus(): TeamStatus {
    return { ...this.statuses };
  }
}

// -----------------------------------------------------------------------------
// Worker entrypoint
//
// When this module is executed inside a Worker (isMainThread === false) we
// should do nothing. All worker logic is generated dynamically in run(). The
// block below exists to avoid executing the main thread logic when the file
// itself is required by the worker. If we placed top‑level code in this
// module without this guard, it could run twice (once in main, once in
// worker), leading to undesired side effects.

if (!isMainThread) {
  // The actual worker code is injected by IntelligenceTeam.run() via the
  // workerScript string. When this file is executed in a worker context we
  // return immediately to prevent re‑running the class definitions. If we do
  // nothing here the injected script will be evaluated independently.
  // eslint-disable-next-line no-empty
}
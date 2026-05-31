/**
 * @file bootstrap.ts
 * @description BootstrapRunner — first-run onboarding dialogue for SUDO-AI.
 *
 * On first run, BOOTSTRAP.md exists in the workspace. The runner walks the user
 * through a multi-step dialogue to collect identity and persona information,
 * writes the results to IDENTITY.md and USER.md, then deletes BOOTSTRAP.md to
 * signal that onboarding is complete.
 *
 * The runner is channel-agnostic: it communicates via injected send/receive
 * callbacks so it works identically over Telegram, Discord, Electron, etc.
 */

import { createLogger } from '../shared/index.js';
import { sleep } from '../shared/index.js';
import type { WorkspaceManager } from './files.js';
import type { BootstrapState } from './types.js';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../shared/index.js';

const log = createLogger('workspace:bootstrap');

/** A function that sends a message to the peer. */
export type BootstrapSendFn = (text: string) => Promise<void>;

/**
 * A function that waits for the next text reply from the peer.
 * Must resolve with the reply text or reject with a timeout error.
 */
export type BootstrapReceiveFn = () => Promise<string>;

/** One step in the onboarding dialogue. */
interface BootstrapStep {
  /** Unique field key stored in BootstrapState.data. */
  key: string;
  /** Prompt sent to the user. */
  prompt: string;
  /** Optional validation; returns an error message string or null if valid. */
  validate?: (input: string) => string | null;
  /** Optional transform applied to the raw input before storing. */
  transform?: (input: string) => string;
}

/** The ordered sequence of bootstrap steps. */
const STEPS: BootstrapStep[] = [
  {
    key: 'ownerName',
    prompt:
      'Welcome to SUDO-AI first-run setup!\n\nWhat is your name? (I will use this to personalize our interactions)',
    validate: (v) => (v.trim().length < 1 ? 'Please enter a name.' : null),
    transform: (v) => v.trim(),
  },
  {
    key: 'agentName',
    prompt: 'What would you like to call me? (default: SUDO)',
    transform: (v) => (v.trim().length > 0 ? v.trim() : 'SUDO'),
  },
  {
    key: 'vibe',
    prompt:
      'How should I behave? Describe my personality in a few words.\n(e.g. "focused and direct", "friendly and curious", "professional")',
    validate: (v) => (v.trim().length < 3 ? 'Please provide at least a few words.' : null),
    transform: (v) => v.trim(),
  },
  {
    key: 'timezone',
    prompt: 'What is your timezone? (e.g. Asia/Kolkata, UTC, America/New_York)',
    validate: (v) => {
      const valid = /^[A-Za-z_/+\-0-9]+$/.test(v.trim());
      return valid ? null : 'Please enter a valid IANA timezone string.';
    },
    transform: (v) => v.trim(),
  },
  {
    key: 'goals',
    prompt:
      'What are your top priorities for me to help with? (e.g. "YouTube automation, coding, research")',
    transform: (v) => v.trim(),
  },
];

/** Typing delay simulation between sends (ms). */
const SEND_DELAY_MS = 300;

/**
 * Runs the first-run onboarding dialogue.
 *
 * @example
 * ```ts
 * const runner = new BootstrapRunner(workspaceManager, sendFn, receiveFn);
 * const completed = await runner.run();
 * ```
 */
export class BootstrapRunner {
  private state: BootstrapState = { completed: false, step: 0, data: {} };

  /**
   * @param workspace  - WorkspaceManager for reading/writing files.
   * @param send       - Function that delivers a message to the peer.
   * @param receive    - Function that waits for and returns the next peer reply.
   */
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly send: BootstrapSendFn,
    private readonly receive: BootstrapReceiveFn,
  ) {}

  /**
   * Check whether bootstrap has already been completed.
   * Bootstrap is considered done when BOOTSTRAP.md does not exist.
   */
  isRequired(): boolean {
    return this.workspace.exists('BOOTSTRAP');
  }

  /**
   * Execute the full onboarding dialogue.
   * Returns true if the bootstrap completed successfully, false if skipped.
   *
   * @throws If any send/receive call fails unrecoverably.
   */
  async run(): Promise<boolean> {
    if (!this.isRequired()) {
      log.info('Bootstrap already completed — BOOTSTRAP.md not present');
      return false;
    }

    log.info('Starting bootstrap onboarding dialogue');

    for (let stepIndex = this.state.step; stepIndex < STEPS.length; stepIndex++) {
      const step = STEPS[stepIndex];
      if (!step) continue;

      this.state.step = stepIndex;
      const value = await this._runStep(step);
      this.state.data[step.key] = value;

      log.debug({ step: step.key, value }, 'bootstrap step collected');
      await sleep(SEND_DELAY_MS);
    }

    // Confirm collected data
    await this._sendConfirmation();

    // Persist results
    await this._applyResults();

    // Self-destruct BOOTSTRAP.md
    await this._deleteBootstrapFile();

    this.state.completed = true;
    log.info('Bootstrap onboarding completed');
    return true;
  }

  /** Expose collected state for logging/debugging. */
  get currentState(): Readonly<BootstrapState> {
    return { ...this.state, data: { ...this.state.data } };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async _runStep(step: BootstrapStep): Promise<string> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.send(step.prompt);
      const raw = await this.receive();

      if (step.validate) {
        const errMsg = step.validate(raw);
        if (errMsg) {
          await this.send(`Invalid input: ${errMsg} Please try again.`);
          continue;
        }
      }

      return step.transform ? step.transform(raw) : raw.trim();
    }

    // After max retries, accept whatever was last received
    log.warn({ step: step.key }, 'Step exceeded max retries — using last raw input');
    return (this.state.data[step.key] ?? '').trim();
  }

  private async _sendConfirmation(): Promise<void> {
    const { ownerName, agentName, vibe, timezone, goals } = this.state.data;
    const summary = [
      `Perfect, ${ownerName ?? 'friend'}! Here is what I have captured:`,
      `- My name: ${agentName ?? 'SUDO'}`,
      `- Personality: ${vibe ?? 'balanced'}`,
      `- Timezone: ${timezone ?? 'UTC'}`,
      `- Your priorities: ${goals ?? 'not specified'}`,
      '',
      'Setting everything up now...',
    ].join('\n');

    await this.send(summary);
  }

  private async _applyResults(): Promise<void> {
    const { ownerName, agentName, vibe, timezone, goals } = this.state.data;

    // Write IDENTITY.md
    const identityContent = [
      `# SUDO-AI Identity`,
      ``,
      `## Name`,
      agentName ?? 'SUDO',
      ``,
      `## Personality`,
      vibe ?? 'balanced, helpful, and direct',
      ``,
      `## Timezone`,
      timezone ?? 'UTC',
      ``,
      `## Core Goals`,
      goals ?? 'Assist the owner with their priorities',
      ``,
      `_Generated by bootstrap on ${new Date().toISOString()}_`,
    ].join('\n');

    await this.workspace.writeFile('IDENTITY', identityContent);
    log.info('IDENTITY.md written');

    // Write USER.md
    const userContent = [
      `# User Profile`,
      ``,
      `## Name`,
      ownerName ?? 'Owner',
      ``,
      `## Preferences`,
      `- Timezone: ${timezone ?? 'UTC'}`,
      ``,
      `## Goals`,
      goals ?? 'Not specified',
      ``,
      `_Last updated: ${new Date().toISOString()}_`,
    ].join('\n');

    await this.workspace.writeFile('USER', userContent);
    log.info('USER.md written');
  }

  private async _deleteBootstrapFile(): Promise<void> {
    const filePath = path.join(path.resolve(PATHS.WORKSPACE), 'BOOTSTRAP.md');
    try {
      await unlink(filePath);
      log.info({ path: filePath }, 'BOOTSTRAP.md deleted — bootstrap marked complete');
    } catch (err) {
      // File may already be gone (idempotent)
      log.warn({ path: filePath, err }, 'Could not delete BOOTSTRAP.md (non-fatal)');
    }
  }
}

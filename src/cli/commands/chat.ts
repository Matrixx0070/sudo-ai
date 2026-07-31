/** @file cli/commands/chat.ts — SUDO-AI terminal TUI entry point (Ink-based). */

import React from 'react';
import { render } from 'ink';
import { App } from './chat/App.js';
import { installWarningFilter } from './chat-warning-filter.js';

export async function runChat(): Promise<void> {
  // SCAFFOLD: upstream Ink/React dev-build artifact — see chat-warning-filter.ts.
  const restoreStderr = installWarningFilter();
  const { waitUntilExit } = render(
    React.createElement(App),
    { exitOnCtrlC: false },
  );

  try {
    await waitUntilExit();
  } catch {
    // Ink throws on process.exit; absorb cleanly
  }

  restoreStderr();

  // Goodbye printed after ink teardown
  process.stdout.write('\nGoodbye.\n');
}

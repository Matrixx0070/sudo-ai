/** @file cli/commands/chat.ts — SUDO-AI terminal TUI entry point (Ink-based). */

import React from 'react';
import { render } from 'ink';
import { App } from './chat/App.js';

export async function runChat(): Promise<void> {
  const { waitUntilExit } = render(
    React.createElement(App),
    { exitOnCtrlC: false },
  );

  try {
    await waitUntilExit();
  } catch {
    // Ink throws on process.exit; absorb cleanly
  }

  // Goodbye printed after ink teardown
  process.stdout.write('\nGoodbye.\n');
}

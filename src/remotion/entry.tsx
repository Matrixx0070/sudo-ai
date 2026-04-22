/**
 * entry.tsx — Remotion CLI entry point.
 * Calls registerRoot() with RemotionRoot.
 * Use this file as the entry point for npx remotion commands.
 *
 * Example:
 *   npx remotion still src/remotion/entry.tsx SudoAgents --output=sudo-agents-spritesheet.png
 */

import React from 'react';
import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);

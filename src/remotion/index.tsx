/**
 * index.tsx — Remotion entry point for SUDO-AI v3.
 * This file calls registerRoot() as required by the Remotion CLI.
 * Usage: npx remotion still src/remotion/index.tsx SudoAgents output.png
 */

import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);

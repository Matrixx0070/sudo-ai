/**
 * index.tsx — Remotion Composition registration for SUDO-AI agent characters.
 * Registers "SudoAgents" at 1920x400, 1fps, 1 frame.
 *
 * Entry point: src/remotion/characters/index.tsx
 * Usage: npx remotion still src/remotion/characters/index.tsx SudoAgents output.png
 */

import React from 'react';
import { Composition } from 'remotion';
import { AllAgents } from './AllAgents';

// ---------------------------------------------------------------------------
// Re-exports for convenience (consumers can import characters from this index)
// ---------------------------------------------------------------------------

export { default as Nova  } from './Nova';
export { default as Kuro  } from './Kuro';
export { default as Pixel } from './Pixel';
export { default as Bolt  } from './Bolt';
export { default as Echo  } from './Echo';
export { default as Flux  } from './Flux';
export { default as Vex   } from './Vex';
export { default as Aria  } from './Aria';
export { AllAgents } from './AllAgents';

// Animation CSS exports
export { novaAnimations  } from './Nova';
export { kuroAnimations  } from './Kuro';
export { pixelAnimations } from './Pixel';
export { boltAnimations  } from './Bolt';
export { echoAnimations  } from './Echo';
export { fluxAnimations  } from './Flux';
export { vexAnimations   } from './Vex';
export { ariaAnimations  } from './Aria';

// ---------------------------------------------------------------------------
// Remotion root — registers SudoAgents composition
// ---------------------------------------------------------------------------

export const RemotionAgentsRoot: React.FC = () => (
  <Composition
    id="SudoAgents"
    component={AllAgents}
    durationInFrames={1}
    fps={1}
    width={1920}
    height={400}
  />
);

// Alias expected by Root.tsx
export const SudoAgentsComposition = RemotionAgentsRoot;

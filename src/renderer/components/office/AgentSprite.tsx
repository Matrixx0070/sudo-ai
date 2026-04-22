/**
 * AgentSprite
 *
 * Renders an agent using a per-pose PNG file (~370×1022 px natural size).
 * Each character has four individual image files following the pattern:
 *   {name}-sitting.png | {name}-standing.png | {name}-walk-right.png | {name}-walk-left.png
 *
 * The image is displayed at 48 px wide with auto height so aspect ratio is
 * preserved regardless of the natural image dimensions.
 *
 * Position is driven by 2-D percentage coordinates (x%, y%) that map to
 * `left` / `top` absolute placement within the office container. CSS
 * transitions on those properties produce smooth movement.
 */

import React, { useCallback } from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import type { AgentCode, AgentDefinition, AgentRuntime, AgentState } from './types.js';
import './crystal-office.css';

// ---------------------------------------------------------------------------
// Agent name map — maps AgentCode to the character name used in filenames
// ---------------------------------------------------------------------------

const AGENT_NAMES: Record<AgentCode, string> = {
  'SUDO-1': 'nova',
  'SUDO-2': 'kuro',
  'SUDO-3': 'pixel',
  'SUDO-4': 'bolt',
  'SUDO-5': 'echo',
  'SUDO-6': 'flux',
  'SUDO-7': 'vex',
  'SUDO-8': 'aria',
};

// ---------------------------------------------------------------------------
// Pose types and URL builder
// ---------------------------------------------------------------------------

type PoseKey = 'sitting' | 'standing' | 'walk-right' | 'walk-left';

function getSpriteSrc(code: AgentCode, pose: PoseKey): string {
  return `/office/characters/${AGENT_NAMES[code]}-${pose}.png`;
}

// ---------------------------------------------------------------------------
// Pose mapping — agent state → PoseKey
// ---------------------------------------------------------------------------

function stateToPose(state: AgentState): PoseKey {
  switch (state) {
    case 'working':   return 'sitting';   // sitting at desk
    case 'idle':      return 'standing';  // standing
    case 'thinking':  return 'standing';  // standing (thoughtPulse CSS handles glow)
    case 'talking':   return 'standing';  // standing
    case 'walking':   return 'walk-right'; // walking right
    case 'break':     return 'walk-left'; // walking left (heading to break room)
    case 'error':     return 'standing';  // standing (errorShake CSS handles shake)
    default:          return 'standing';
  }
}

// Display width for the sprite — images are ~370 px wide naturally, scaled down
const SPRITE_DISPLAY_W = 48;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentSpriteProps {
  agentCode: AgentCode;
  definition: AgentDefinition;
  /** % from left edge of parent */
  x: number;
  /** % from top edge of parent */
  y: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentSprite({ agentCode, definition, x, y }: AgentSpriteProps): React.ReactElement | null {
  const runtime = useOfficeStore((s) => s.agents[agentCode]) as AgentRuntime | undefined;
  const selectAgent = useOfficeStore((s) => s.selectAgent);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // don't trigger room-zone click
      selectAgent(agentCode);
    },
    [agentCode, selectAgent],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        selectAgent(agentCode);
      }
    },
    [agentCode, selectAgent],
  );

  if (!runtime) return null;

  const pose = stateToPose(runtime.state);
  const spriteSrc = getSpriteSrc(agentCode, pose);

  if (!AGENT_NAMES[agentCode]) {
    console.warn(`[AgentSprite] No agent name registered for agent code: ${agentCode}`);
    return null;
  }

  const stateClass = `state-${runtime.state}`;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${definition.name} — ${runtime.state}`}
      className="agent-sprite-wrapper"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        /* Colored glow border matching the agent's accent color */
        boxShadow: `0 0 12px 2px ${definition.color}55`,
        borderRadius: 6,
      }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Sprite image — individual per-pose PNG scaled to display width */}
      <img
        src={spriteSrc}
        alt={`${definition.name} sprite`}
        className={`agent-sprite ${stateClass}`}
        draggable={false}
        style={{
          width: SPRITE_DISPLAY_W,
          height: 'auto',
          /* The img is a block child of the flex wrapper; no extra transforms */
          position: 'relative',
          top: 0,
          left: 0,
        }}
      />

      {/* Always-visible name tag below the sprite */}
      <div className="agent-name-tag" aria-hidden="true">
        <span
          className="agent-name-tag__dot"
          style={{ background: definition.color }}
        />
        <span className="agent-name-tag__label">{definition.name}</span>
      </div>

      {/* Task progress micro-bar */}
      {runtime.currentTask !== null && runtime.taskProgress > 0 && (
        <div
          aria-hidden="true"
          style={{
            width: SPRITE_DISPLAY_W,
            height: 3,
            borderRadius: 2,
            background: 'rgba(0,0,0,0.5)',
            overflow: 'hidden',
            marginTop: 3,
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${Math.min(100, runtime.taskProgress)}%`,
              background: definition.color,
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      )}
    </div>
  );
}

export default AgentSprite;

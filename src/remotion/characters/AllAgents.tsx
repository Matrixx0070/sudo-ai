/**
 * AllAgents.tsx — All 8 SUDO-AI agents side by side.
 * Canvas: 1920x400, dark background #0a0e1a.
 * Each character occupies a 220px slot (8 × 220 = 1760, centered in 1920).
 * Name label rendered below each character.
 */

import React from 'react';
import Nova from './Nova';
import Kuro from './Kuro';
import Pixel from './Pixel';
import Bolt from './Bolt';
import Echo from './Echo';
import Flux from './Flux';
import Vex from './Vex';
import Aria from './Aria';

// ---------------------------------------------------------------------------
// Agent manifest
// ---------------------------------------------------------------------------

interface AgentEntry {
  name: string;
  color: string;
  Component: React.FC;
}

const AGENTS: AgentEntry[] = [
  { name: 'Nova',  color: '#3b82f6', Component: Nova  },
  { name: 'Kuro',  color: '#dc2626', Component: Kuro  },
  { name: 'Pixel', color: '#a855f7', Component: Pixel },
  { name: 'Bolt',  color: '#eab308', Component: Bolt  },
  { name: 'Echo',  color: '#14b8a6', Component: Echo  },
  { name: 'Flux',  color: '#f97316', Component: Flux  },
  { name: 'Vex',   color: '#22c55e', Component: Vex   },
  { name: 'Aria',  color: '#f59e0b', Component: Aria  },
];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const CANVAS_W  = 1920;
const CANVAS_H  = 400;
const SLOT_W    = 220;
const CHAR_W    = 200;
const CHAR_H    = 350;
const LABEL_Y   = 384;
const TOTAL_W   = AGENTS.length * SLOT_W;
const START_X   = (CANVAS_W - TOTAL_W) / 2; // centers the grid

// ---------------------------------------------------------------------------
// Separator glyph between agents
// ---------------------------------------------------------------------------

const Separator: React.FC<{ x: number }> = ({ x }) => (
  <line
    x1={x} y1={20}
    x2={x} y2={360}
    stroke="#1e2a3e"
    strokeWidth="1"
    strokeDasharray="4 6"
    opacity="0.5"
  />
);

// ---------------------------------------------------------------------------
// AllAgents component
// ---------------------------------------------------------------------------

export const AllAgents: React.FC = () => (
  <svg
    viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
    width={CANVAS_W}
    height={CANVAS_H}
    xmlns="http://www.w3.org/2000/svg"
    aria-label="SUDO-AI Agents Spritesheet"
    role="img"
  >
    {/* Background */}
    <rect width={CANVAS_W} height={CANVAS_H} fill="#0a0e1a" />

    {/* Per-agent color wash behind each slot */}
    {AGENTS.map(({ name, color }, i) => {
      const slotX = START_X + i * SLOT_W;
      const cx2 = slotX + SLOT_W / 2;
      return (
        <ellipse
          key={`bg-wash-${name}`}
          cx={cx2}
          cy={CANVAS_H / 2}
          rx={SLOT_W * 0.65}
          ry={CANVAS_H * 0.6}
          fill={color}
          opacity="0.12"
          style={{ filter: 'blur(30px)' }}
        />
      );
    })}

    {/* Light rays per slot */}
    {AGENTS.map(({ name, color }, i) => {
      const slotX = START_X + i * SLOT_W;
      const cx2 = slotX + SLOT_W / 2;
      return (
        <g key={`rays-${name}`}>
          <line x1={cx2} y1={0} x2={cx2 - 30} y2={CANVAS_H} stroke={color} strokeWidth="1.5" opacity="0.05" />
          <line x1={cx2 + 8} y1={0} x2={cx2 - 15} y2={CANVAS_H} stroke={color} strokeWidth="1" opacity="0.04" />
          <line x1={cx2 - 8} y1={0} x2={cx2 + 15} y2={CANVAS_H} stroke={color} strokeWidth="1" opacity="0.04" />
        </g>
      );
    })}

    {/* Subtle grid backdrop */}
    {Array.from({ length: 20 }, (_, i) => (
      <line
        key={`hg-${i}`}
        x1={0} y1={i * 22}
        x2={CANVAS_W} y2={i * 22}
        stroke="#ffffff"
        strokeWidth="0.3"
        opacity="0.03"
      />
    ))}
    {Array.from({ length: 88 }, (_, i) => (
      <line
        key={`vg-${i}`}
        x1={i * 22} y1={0}
        x2={i * 22} y2={CANVAS_H}
        stroke="#ffffff"
        strokeWidth="0.3"
        opacity="0.03"
      />
    ))}

    {/* Separators */}
    {AGENTS.map((_, i) => (
      i > 0 && (
        <Separator key={`sep-${i}`} x={START_X + i * SLOT_W} />
      )
    ))}

    {/* Agent slots */}
    {AGENTS.map(({ name, color, Component }, i) => {
      const slotX = START_X + i * SLOT_W;
      const charX = slotX + (SLOT_W - CHAR_W) / 2;
      const charY = (CANVAS_H - CHAR_H - 28) / 2; // vertically center chars leaving label space

      return (
        <g key={name} aria-label={`${name} agent`}>
          {/* Character SVG embedded via foreignObject scaling trick */}
          <g transform={`translate(${charX}, ${charY})`}>
            <Component />
          </g>

          {/* Name label */}
          <text
            x={slotX + SLOT_W / 2}
            y={LABEL_Y}
            textAnchor="middle"
            fontFamily="'Segoe UI', 'Inter', sans-serif"
            fontSize="15"
            fontWeight="600"
            letterSpacing="2"
            fill={color}
            opacity="0.92"
          >
            {name.toUpperCase()}
          </text>

          {/* Underline accent */}
          <line
            x1={slotX + SLOT_W / 2 - 20}
            y1={LABEL_Y + 5}
            x2={slotX + SLOT_W / 2 + 20}
            y2={LABEL_Y + 5}
            stroke={color}
            strokeWidth="1.5"
            opacity="0.45"
          />
        </g>
      );
    })}

    {/* SUDO-AI watermark */}
    <text
      x={CANVAS_W / 2}
      y={CANVAS_H - 8}
      textAnchor="middle"
      fontFamily="'Segoe UI', 'Inter', sans-serif"
      fontSize="10"
      fill="#ffffff"
      opacity="0.12"
      letterSpacing="4"
    >
      SUDO-AI AGENT TEAM
    </text>
  </svg>
);

export default AllAgents;

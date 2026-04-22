/**
 * Flux.tsx — Male agent, #f97316 orange, standing / writing on whiteboard.
 * Messy hair, energetic expression, arm raised writing.
 * ViewBox 200x350.
 */

import React from 'react';
import { AgentDefs, Head, SuitBody, Arm, Leg, lighten } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID    = 'flux';
const COLOR = '#f97316';
const SKIN  = '#f2b882';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const fluxAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.01); transform-origin: bottom center; }
  }
  @keyframes write {
    0%, 100% { transform: translate(0, 0) rotate(0deg); transform-origin: 148px 160px; }
    25%       { transform: translate(6px, 0) rotate(2deg); transform-origin: 148px 160px; }
    75%       { transform: translate(-4px, 2px) rotate(-1deg); transform-origin: 148px 160px; }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .flux         { animation: breathe 2.6s ease-in-out infinite; }
  .flux-arm     { animation: write 1.8s ease-in-out infinite; }
`;

// ---------------------------------------------------------------------------
// Whiteboard prop
// ---------------------------------------------------------------------------

const Whiteboard: React.FC = () => (
  <g>
    {/* Board frame */}
    <rect x={118} y={80} width={70} height={55} rx={3} fill="#e8e8f4" stroke="#c0c0d0" strokeWidth="1.5" />
    {/* Board content — formula lines */}
    <line x1={124} y1={92} x2={162} y2={92} stroke="#2a2a4a" strokeWidth="1.8" />
    <path d="M 124 100 Q 132 96 140 102 Q 148 108 156 100" fill="none" stroke="#2a2a4a" strokeWidth="1.5" />
    <line x1={124} y1={112} x2={148} y2={112} stroke="#2a2a4a" strokeWidth="1.2" />
    <circle cx={155} cy={112} r={3} fill="none" stroke={COLOR} strokeWidth="1.5" />
    {/* Orange chalk mark (in progress) */}
    <path d="M 160 100 L 168 88 L 174 95" fill="none" stroke={COLOR} strokeWidth="2" strokeLinecap="round" opacity="0.85" />
    {/* Board shadow */}
    <rect x={118} y={133} width={70} height={4} rx={2} fill="#0d0d18" opacity="0.2" />
    {/* Tray at bottom */}
    <rect x={116} y={132} width={74} height={6} rx={2} fill="#b0b0c0" />
  </g>
);

// ---------------------------------------------------------------------------
// Messy hair
// ---------------------------------------------------------------------------

const MessyHair: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => (
  <g>
    {/* Base dome */}
    <path
      d={`M ${cx - 36} ${cy - 10} C ${cx - 38} ${cy - 40}, ${cx - 20} ${cy - 56}, ${cx} ${cy - 58} C ${cx + 20} ${cy - 56}, ${cx + 38} ${cy - 40}, ${cx + 36} ${cy - 10} C ${cx + 30} ${cy - 28}, ${cx + 16} ${cy - 38}, ${cx} ${cy - 40} C ${cx - 16} ${cy - 38}, ${cx - 30} ${cy - 28}, ${cx - 36} ${cy - 10} Z`}
      fill={`url(#hair-${ID})`}
    />
    {/* Messy tufts */}
    <path d={`M ${cx - 22} ${cy - 52} L ${cx - 28} ${cy - 66} L ${cx - 16} ${cy - 54} Z`} fill="#7a3200" />
    <path d={`M ${cx - 4}  ${cy - 58} L ${cx - 6}  ${cy - 74} L ${cx + 6}  ${cy - 58} Z`} fill="#6a2800" />
    <path d={`M ${cx + 18} ${cy - 54} L ${cx + 22} ${cy - 68} L ${cx + 28} ${cy - 50} Z`} fill="#7a3200" />
    <path d={`M ${cx + 30} ${cy - 46} L ${cx + 38} ${cy - 58} L ${cx + 36} ${cy - 44} Z`} fill="#6a2800" />
    {/* Side pieces */}
    <path d={`M ${cx - 36} ${cy - 10} C ${cx - 44} ${cy + 4} ${cx - 42} ${cy + 22} ${cx - 38} ${cy + 30}`} fill="none" stroke={`url(#hair-${ID})`} strokeWidth="14" strokeLinecap="round" />
    <path d={`M ${cx + 36} ${cy - 10} C ${cx + 44} ${cy + 4} ${cx + 42} ${cy + 20} ${cx + 38} ${cy + 28}`} fill="none" stroke={`url(#hair-${ID})`} strokeWidth="10" strokeLinecap="round" />
    {/* Orange highlight streaks */}
    <path d={`M ${cx - 5} ${cy - 56} L ${cx - 7} ${cy - 72}`} fill="none" stroke={lighten(COLOR, -10)} strokeWidth="1.8" opacity="0.65" filter={`url(#glow-${ID})`} />
    <path d={`M ${cx + 20} ${cy - 52} L ${cx + 24} ${cy - 66}`} fill="none" stroke={COLOR} strokeWidth="1.5" opacity="0.55" filter={`url(#glow-${ID})`} />
  </g>
);

// ---------------------------------------------------------------------------
// Flux component
// ---------------------------------------------------------------------------

const Flux: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="flux"
    aria-label="Flux — AI agent"
    role="img"
  >
    <style>{fluxAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={80} ry={132} />

    {/* Whiteboard (behind body) */}
    <Whiteboard />

    {/* Legs — standing, slightly turned toward board */}
    <Leg id={ID} side="L" hipX={88}  hipY={244} kneeX={84}  kneeY={288} ankleX={82}  ankleY={330} color={COLOR} />
    <Leg id={ID} side="R" hipX={112} hipY={244} kneeX={116} kneeY={288} ankleX={118} ankleY={330} color={COLOR} />

    {/* Suit torso */}
    <SuitBody id={ID} cx={100} cy={132} color={COLOR} width={88} height={114} gender="M" />

    {/* Left arm — relaxed at side */}
    <Arm
      id={ID}
      side="L"
      shoulderX={57}
      shoulderY={146}
      elbowX={50}
      elbowY={190}
      wristX={55}
      wristY={220}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Right arm — raised, writing on board */}
    <g className="flux-arm">
      <Arm
        id={ID}
        side="R"
        shoulderX={143}
        shoulderY={146}
        elbowX={155}
        elbowY={178}
        wristX={152}
        wristY={152}
        color={COLOR}
        skinTone={SKIN}
      />
      {/* Marker in hand */}
      <rect x={149} y={136} width={5} height={20} rx={2} fill={COLOR} opacity="0.9" filter={`url(#glow-${ID})`} />
    </g>

    {/* Head */}
    <Head
      id={ID}
      cx={100}
      cy={76}
      rx={38}
      ry={44}
      color={COLOR}
      browAngle={-15}
      mouthType="open"
      eyeSpread={14}
    />

    {/* Messy hair */}
    <MessyHair cx={100} cy={78} />
  </svg>
);

export default Flux;

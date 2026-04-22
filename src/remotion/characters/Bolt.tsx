/**
 * Bolt.tsx — Male agent, #eab308 yellow, standing / data-pad pose.
 * Spiky energetic hair, alert wide eyes, one arm holding data pad.
 */

import React from 'react';
import { AgentDefs, Head, SuitBody, Arm, Leg, lighten } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID = 'bolt';
const COLOR = '#eab308';
const SKIN = '#f0b880';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const boltAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.01); transform-origin: bottom center; }
  }
  @keyframes padFloat {
    0%, 100% { transform: translateY(0px) rotate(-3deg); transform-origin: 140px 200px; }
    50%       { transform: translateY(-4px) rotate(-1deg); transform-origin: 140px 200px; }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .bolt         { animation: breathe 2.8s ease-in-out infinite; }
  .bolt-pad     { animation: padFloat 2s ease-in-out infinite; }
`;

const Bolt: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="bolt"
    aria-label="Bolt — AI agent"
    role="img"
  >
    <style>{boltAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={80} ry={135} />

    {/* Legs */}
    <Leg id={ID} side="L" hipX={85} hipY={242} kneeX={82} kneeY={286} ankleX={80} ankleY={330} color={COLOR} />
    <Leg id={ID} side="R" hipX={115} hipY={242} kneeX={118} kneeY={286} ankleX={120} ankleY={330} color={COLOR} />

    {/* Suit torso */}
    <SuitBody id={ID} cx={100} cy={132} color={COLOR} width={88} height={112} gender="M" />

    {/* Right arm — holding data pad at side */}
    <g className="bolt-pad">
      <Arm
        id={ID}
        side="R"
        shoulderX={142}
        shoulderY={148}
        elbowX={148}
        elbowY={190}
        wristX={140}
        wristY={225}
        color={COLOR}
        skinTone={SKIN}
      />
      {/* Data pad */}
      <rect x={128} y={205} width={30} height={42} rx={4} fill="#1a1a2e" stroke={COLOR} strokeWidth="1.5" filter={`url(#glow-${ID})`} />
      <rect x={131} y={209} width={24} height={28} rx={2} fill="#0d1a2e" />
      {/* Screen lines */}
      <line x1={133} y1={213} x2={153} y2={213} stroke={COLOR} strokeWidth="1" opacity="0.6" />
      <line x1={133} y1={218} x2={150} y2={218} stroke={COLOR} strokeWidth="1" opacity="0.45" />
      <line x1={133} y1={223} x2={152} y2={223} stroke={COLOR} strokeWidth="1" opacity="0.35" />
      <circle cx={143} cy={232} r={3} fill={COLOR} opacity="0.5" filter={`url(#glow-${ID})`} />
    </g>

    {/* Left arm — hand on hip */}
    <Arm
      id={ID}
      side="L"
      shoulderX={58}
      shoulderY={148}
      elbowX={48}
      elbowY={190}
      wristX={60}
      wristY={218}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Head */}
    <Head
      id={ID}
      cx={100}
      cy={76}
      rx={37}
      ry={43}
      color={COLOR}
      browAngle={-12}
      mouthType="open"
      eyeSpread={14}
    />

    {/* Spiky hair */}
    {/* Base dome */}
    <path
      d="M 63 62 C 62 32, 78 12, 100 10 C 122 12, 138 32, 137 62 C 132 44, 118 34, 100 32 C 82 34, 68 44, 63 62 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Spikes */}
    <path d="M 80 28 L 72 4 L 88 22 Z" fill="#7a5e00" />
    <path d="M 93 22 L 90 -2 L 103 18 Z" fill="#7a5e00" />
    <path d="M 107 22 L 108 -4 L 118 20 Z" fill="#7a5e00" />
    <path d="M 120 28 L 126 6 L 130 26 Z" fill="#8a6800" />
    <path d="M 68 40 L 58 20 L 72 36 Z" fill="#8a6800" />
    {/* Spike highlights */}
    <path d="M 82 24 L 74 6 L 86 20" fill="none" stroke="#ffe066" strokeWidth="1.5" opacity="0.6" />
    <path d="M 95 18 L 92 0 L 101 16" fill="none" stroke="#ffe066" strokeWidth="1.5" opacity="0.6" />
    {/* Yellow highlight tips */}
    <path d="M 72 4 L 75 8" stroke={lighten(COLOR, 10)} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" filter={`url(#glow-${ID})`} />
    <path d="M 90 -2 L 92 4" stroke={lighten(COLOR, 10)} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" filter={`url(#glow-${ID})`} />
    <path d="M 108 -4 L 110 4" stroke={lighten(COLOR, 10)} strokeWidth="1.5" strokeLinecap="round" opacity="0.6" filter={`url(#glow-${ID})`} />
  </svg>
);

export default Bolt;

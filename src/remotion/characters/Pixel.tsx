/**
 * Pixel.tsx — Female agent, #a855f7 purple, sitting / stylus pose.
 * Purple-tinted layered hair longer on one side, creative playful expression.
 */

import React from 'react';
import { AgentDefs, Head, SuitBody, Arm, Leg, lighten } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID = 'pixel';
const COLOR = '#a855f7';
const SKIN = '#f2c4a0';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const pixelAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.012); transform-origin: bottom center; }
  }
  @keyframes stylus {
    0%, 100% { transform: rotate(-5deg) translate(0,0); transform-origin: 155px 200px; }
    50%       { transform: rotate(5deg) translate(2px, -3px); transform-origin: 155px 200px; }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .pixel          { animation: breathe 3s ease-in-out infinite; }
  .pixel-stylus   { animation: stylus 1.2s ease-in-out infinite; }
`;

const Pixel: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="pixel"
    aria-label="Pixel — AI agent"
    role="img"
  >
    <style>{pixelAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={75} ry={130} />

    {/* Sitting — lap base */}
    <rect x={52} y={222} width={96} height={20} rx={6} fill={`url(#pants-${ID})`} />

    {/* Legs bent */}
    <Leg id={ID} side="L" hipX={78} hipY={222} kneeX={60} kneeY={265} ankleX={50} ankleY={300} color={COLOR} />
    <Leg id={ID} side="R" hipX={122} hipY={222} kneeX={140} kneeY={265} ankleX={150} ankleY={300} color={COLOR} />

    {/* Suit torso */}
    <SuitBody id={ID} cx={100} cy={130} color={COLOR} width={78} height={95} gender="F" />

    {/* Left arm — resting on lap */}
    <Arm
      id={ID}
      side="L"
      shoulderX={63}
      shoulderY={142}
      elbowX={58}
      elbowY={185}
      wristX={68}
      wristY={218}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Right arm — holding stylus, extended */}
    <g className="pixel-stylus">
      <Arm
        id={ID}
        side="R"
        shoulderX={137}
        shoulderY={142}
        elbowX={155}
        elbowY={175}
        wristX={158}
        wristY={210}
        color={COLOR}
        skinTone={SKIN}
      />
      {/* Stylus */}
      <rect x={154} y={200} width={6} height={28} rx={3} fill="#2a2a3e" />
      <ellipse cx={157} cy={200} rx={3} ry={4} fill={COLOR} filter={`url(#glow-${ID})`} />
      <line x1={157} y1={228} x2={157} y2={232} stroke={lighten(COLOR, 20)} strokeWidth="1.5" />
    </g>

    {/* Head */}
    <Head
      id={ID}
      cx={100}
      cy={76}
      rx={36}
      ry={42}
      color={COLOR}
      browAngle={-8}
      mouthType="smile"
      eyeSpread={13}
    />

    {/* Hair — layered, longer on left side */}
    {/* Base */}
    <path
      d="M 64 62 C 62 32, 78 14, 100 12 C 122 14, 138 32, 136 62 C 130 44, 116 36, 100 34 C 84 36, 70 44, 64 62 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Left side longer piece */}
    <path
      d="M 64 62 C 58 75, 55 95, 58 118 C 62 108, 63 85, 66 68 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Right side shorter */}
    <path
      d="M 136 62 C 140 72, 140 85, 137 95 C 135 82, 134 70, 132 62 Z"
      fill="#5a1a8a"
    />
    {/* Top layer depth */}
    <path
      d="M 72 56 C 74 34, 85 20, 100 18 C 115 20, 126 34, 128 56"
      fill="none"
      stroke="#3a0a5a"
      strokeWidth="7"
      opacity="0.45"
    />
    {/* Purple highlight strands */}
    <path d="M 84 14 C 80 22, 78 35, 76 48" fill="none" stroke={COLOR} strokeWidth="1.8" opacity="0.65" filter={`url(#glow-${ID})`} />
    <path d="M 100 12 C 98 20, 96 32, 95 46" fill="none" stroke={lighten(COLOR, 25)} strokeWidth="1.4" opacity="0.55" filter={`url(#glow-${ID})`} />
    <path d="M 116 14 C 120 22, 122 35, 121 48" fill="none" stroke={COLOR} strokeWidth="1.5" opacity="0.5" filter={`url(#glow-${ID})`} />
    {/* Left long strand highlight */}
    <path d="M 60 70 C 56 88, 54 102, 56 116" fill="none" stroke={lighten(COLOR, 15)} strokeWidth="1.5" opacity="0.5" filter={`url(#glow-${ID})`} />
  </svg>
);

export default Pixel;

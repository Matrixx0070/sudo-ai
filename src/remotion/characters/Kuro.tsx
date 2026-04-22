/**
 * Kuro.tsx — Male agent, #dc2626 red, standing / arms-crossed pose.
 * Dark slicked-back hair, intense serious expression, sharp eyebrows.
 */

import React from 'react';
import { AgentDefs, GlowAura, Head, SuitBody, Arm, Leg } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID = 'kuro';
const COLOR = '#dc2626';
const SKIN = '#e8b090';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const kuroAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.01); transform-origin: bottom center; }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .kuro { animation: breathe 3.5s ease-in-out infinite; }
`;

// ---------------------------------------------------------------------------
// Kuro character — viewBox 0 0 200 350
// ---------------------------------------------------------------------------

const Kuro: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="kuro"
    aria-label="Kuro — AI agent"
    role="img"
  >
    <style>{kuroAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={80} ry={135} />

    {/* Legs — straight, standing */}
    <Leg id={ID} side="L" hipX={85} hipY={240} kneeX={82} kneeY={285} ankleX={80} ankleY={330} color={COLOR} />
    <Leg id={ID} side="R" hipX={115} hipY={240} kneeX={118} kneeY={285} ankleX={120} ankleY={330} color={COLOR} />

    {/* Suit torso — wider shoulders for M */}
    <SuitBody id={ID} cx={100} cy={130} color={COLOR} width={90} height={112} gender="M" />

    {/* Arms crossed — left arm over right */}
    {/* Right arm, underneath */}
    <Arm
      id={ID}
      side="R"
      shoulderX={143}
      shoulderY={145}
      elbowX={120}
      elbowY={185}
      wristX={80}
      wristY={190}
      color={COLOR}
      skinTone={SKIN}
    />
    {/* Left arm, on top */}
    <Arm
      id={ID}
      side="L"
      shoulderX={57}
      shoulderY={145}
      elbowX={80}
      elbowY={185}
      wristX={118}
      wristY={195}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Head */}
    <Head
      id={ID}
      cx={100}
      cy={76}
      rx={38}
      ry={44}
      color={COLOR}
      browAngle={18}
      mouthType="neutral"
      eyeSpread={14}
    />

    {/* Slicked-back hair */}
    <path
      d="M 62 58 C 60 28, 76 10, 100 8 C 124 10, 140 28, 138 58 C 134 40, 118 30, 100 28 C 82 30, 66 40, 62 58 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Slick depth */}
    <path
      d="M 70 50 C 72 28, 84 16, 100 14 C 116 16, 128 28, 130 50"
      fill="none"
      stroke="#5a0000"
      strokeWidth="8"
      opacity="0.5"
    />
    {/* Hair shine line */}
    <path
      d="M 78 12 C 82 18, 84 28, 83 42"
      fill="none"
      stroke="#ff6b6b"
      strokeWidth="2"
      opacity="0.5"
    />
    <path
      d="M 100 8 C 100 14, 100 24, 99 40"
      fill="none"
      stroke="#ff6b6b"
      strokeWidth="1.5"
      opacity="0.4"
    />
    {/* Widow's peak / hairline */}
    <path
      d="M 62 58 C 68 48, 80 42, 100 42 C 120 42, 132 48, 138 58"
      fill="none"
      stroke="#7a0000"
      strokeWidth="3"
    />
  </svg>
);

export default Kuro;

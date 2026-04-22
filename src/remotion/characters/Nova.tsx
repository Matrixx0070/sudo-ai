/**
 * Nova.tsx — Female agent, #3b82f6 blue, sitting/typing pose.
 * Short dark hair with blue highlights, focused expression, slight smile.
 */

import React from 'react';
import { AgentDefs, GlowAura, Head, SuitBody, Arm, Leg, lighten } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID = 'nova';
const COLOR = '#3b82f6';
const SKIN = '#f0c090';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const novaAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.012); transform-origin: bottom center; }
  }
  @keyframes typing {
    0%, 100% { transform: translateY(0px); }
    25%       { transform: translateY(-2px); }
    75%       { transform: translateY(1px); }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .nova          { animation: breathe 3s ease-in-out infinite; }
  .nova-hands    { animation: typing 0.5s ease-in-out infinite; }
`;

// ---------------------------------------------------------------------------
// Nova character — viewBox 0 0 200 350
// ---------------------------------------------------------------------------

const Nova: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="nova"
    aria-label="Nova — AI agent"
    role="img"
  >
    <style>{novaAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={75} ry={130} />

    {/* ---- SITTING BODY ---- */}

    {/* Lap / seat base */}
    <rect x={52} y={220} width={96} height={22} rx={6} fill={`url(#pants-${ID})`} />

    {/* Left leg (bent, going forward-down) */}
    <Leg
      id={ID}
      side="L"
      hipX={78}
      hipY={220}
      kneeX={62}
      kneeY={260}
      ankleX={52}
      ankleY={295}
      color={COLOR}
    />

    {/* Right leg */}
    <Leg
      id={ID}
      side="R"
      hipX={122}
      hipY={220}
      kneeX={138}
      kneeY={260}
      ankleX={148}
      ankleY={295}
      color={COLOR}
    />

    {/* Suit torso */}
    <SuitBody id={ID} cx={100} cy={128} color={COLOR} width={80} height={95} gender="F" />

    {/* Left arm — extended forward, typing */}
    <Arm
      id={ID}
      side="L"
      shoulderX={62}
      shoulderY={140}
      elbowX={46}
      elbowY={185}
      wristX={52}
      wristY={220}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Right arm — extended forward, typing */}
    <Arm
      id={ID}
      side="R"
      shoulderX={138}
      shoulderY={140}
      elbowX={154}
      elbowY={185}
      wristX={148}
      wristY={220}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Holographic keyboard glow */}
    <g className="nova-hands">
      <rect x={48} y={228} width={104} height={6} rx={3} fill={COLOR} opacity="0.18" filter={`url(#glow-${ID})`} />
      {[55, 65, 75, 85, 95, 105, 115, 125, 135, 145].map((kx) => (
        <rect key={kx} x={kx} y={226} width={7} height={4} rx={1} fill={COLOR} opacity="0.25" />
      ))}
    </g>

    {/* Head */}
    <Head
      id={ID}
      cx={100}
      cy={78}
      rx={36}
      ry={42}
      color={COLOR}
      browAngle={-5}
      mouthType="slight"
      eyeSpread={13}
    />

    {/* Hair — short, layered */}
    {/* Base hair shape */}
    <path
      d="M 64 60 C 62 30, 78 14, 100 12 C 122 14, 138 30, 136 60 C 132 44, 120 38, 100 36 C 80 38, 68 44, 64 60 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Hair depth layer */}
    <path
      d="M 68 56 C 70 36, 82 22, 100 20 C 118 22, 130 36, 132 56 C 126 42, 114 34, 100 33 C 86 34, 74 42, 68 56 Z"
      fill="#0a2255"
      opacity="0.7"
    />
    {/* Short hair sides */}
    <path d="M 64 60 C 60 70, 62 85, 68 90 C 64 78, 66 66, 68 60 Z" fill={`url(#hair-${ID})`} />
    <path d="M 136 60 C 140 70, 138 85, 132 90 C 136 78, 134 66, 132 60 Z" fill={`url(#hair-${ID})`} />

    {/* Blue highlight strands */}
    <path
      d="M 88 14 C 84 20, 82 30, 80 40"
      fill="none"
      stroke={lighten(COLOR, 20)}
      strokeWidth="1.5"
      opacity="0.7"
      filter={`url(#glow-${ID})`}
    />
    <path
      d="M 100 12 C 98 18, 97 28, 96 38"
      fill="none"
      stroke={COLOR}
      strokeWidth="1.2"
      opacity="0.6"
      filter={`url(#glow-${ID})`}
    />
    <path
      d="M 112 14 C 116 20, 118 30, 118 40"
      fill="none"
      stroke={lighten(COLOR, 15)}
      strokeWidth="1.2"
      opacity="0.5"
      filter={`url(#glow-${ID})`}
    />
  </svg>
);

export default Nova;

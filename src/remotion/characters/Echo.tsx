/**
 * Echo.tsx — Female agent, #14b8a6 teal, sitting / analytical pose.
 * Long dark hair in ponytail, calm analytical expression, floating data orbs.
 */

import React from 'react';
import { AgentDefs, Head, SuitBody, Arm, Leg, lighten } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID = 'echo';
const COLOR = '#14b8a6';
const SKIN = '#edbf96';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const echoAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.012); transform-origin: bottom center; }
  }
  @keyframes orbFloat1 {
    0%, 100% { transform: translate(0, 0); }
    50%       { transform: translate(4px, -6px); }
  }
  @keyframes orbFloat2 {
    0%, 100% { transform: translate(0, 0); }
    50%       { transform: translate(-3px, -4px); }
  }
  @keyframes orbFloat3 {
    0%, 100% { transform: translate(0, 0); }
    50%       { transform: translate(2px, 5px); }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .echo        { animation: breathe 3s ease-in-out infinite; }
  .echo-orb-1  { animation: orbFloat1 2.4s ease-in-out infinite; }
  .echo-orb-2  { animation: orbFloat2 3s ease-in-out infinite; }
  .echo-orb-3  { animation: orbFloat3 2.7s ease-in-out infinite; }
`;

const Orb: React.FC<{ cx: number; cy: number; r: number; color: string; id: string; cls: string }> = ({
  cx,
  cy,
  r,
  color,
  id,
  cls,
}) => (
  <g className={cls}>
    <circle cx={cx} cy={cy} r={r + 4} fill={color} opacity="0.12" filter={`url(#glow-${id})`} />
    <circle cx={cx} cy={cy} r={r} fill={color} opacity="0.55" filter={`url(#glow-${id})`} />
    <circle cx={cx - r * 0.35} cy={cy - r * 0.35} r={r * 0.3} fill="white" opacity="0.5" />
  </g>
);

const Echo: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="echo"
    aria-label="Echo — AI agent"
    role="img"
  >
    <style>{echoAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={78} ry={132} />

    {/* Floating data orbs */}
    <Orb cx={34} cy={110} r={7} color={COLOR} id={ID} cls="echo-orb-1" />
    <Orb cx={168} cy={95} r={5} color={COLOR} id={ID} cls="echo-orb-2" />
    <Orb cx={22} cy={160} r={4} color={COLOR} id={ID} cls="echo-orb-3" />
    <Orb cx={175} cy={148} r={6} color={COLOR} id={ID} cls="echo-orb-1" />
    <Orb cx={158} cy={175} r={3.5} color={lighten(COLOR, 15)} id={ID} cls="echo-orb-3" />

    {/* Connection lines between orbs */}
    <line x1={34} y1={110} x2={168} y2={95} stroke={COLOR} strokeWidth="0.5" opacity="0.2" strokeDasharray="3 4" />
    <line x1={34} y1={110} x2={22} y2={160} stroke={COLOR} strokeWidth="0.5" opacity="0.15" strokeDasharray="3 4" />
    <line x1={168} y1={95} x2={175} y2={148} stroke={COLOR} strokeWidth="0.5" opacity="0.2" strokeDasharray="3 4" />

    {/* Sitting — lap base */}
    <rect x={52} y={222} width={96} height={20} rx={6} fill={`url(#pants-${ID})`} />

    {/* Legs bent */}
    <Leg id={ID} side="L" hipX={78} hipY={222} kneeX={60} kneeY={264} ankleX={50} ankleY={300} color={COLOR} />
    <Leg id={ID} side="R" hipX={122} hipY={222} kneeX={140} kneeY={264} ankleX={150} ankleY={300} color={COLOR} />

    {/* Suit torso */}
    <SuitBody id={ID} cx={100} cy={130} color={COLOR} width={78} height={95} gender="F" />

    {/* Both arms — hands resting together on desk */}
    <Arm
      id={ID}
      side="L"
      shoulderX={63}
      shoulderY={142}
      elbowX={72}
      elbowY={185}
      wristX={88}
      wristY={218}
      color={COLOR}
      skinTone={SKIN}
    />
    <Arm
      id={ID}
      side="R"
      shoulderX={137}
      shoulderY={142}
      elbowX={128}
      elbowY={185}
      wristX={112}
      wristY={218}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Desk surface hint */}
    <rect x={55} y={228} width={90} height={5} rx={2} fill="#1e2a3a" opacity="0.5" />
    <line x1={55} y1={228} x2={145} y2={228} stroke={COLOR} strokeWidth="0.8" opacity="0.3" />

    {/* Head */}
    <Head
      id={ID}
      cx={100}
      cy={76}
      rx={36}
      ry={42}
      color={COLOR}
      browAngle={-3}
      mouthType="slight"
      eyeSpread={13}
    />

    {/* Long hair — down */}
    <path
      d="M 64 60 C 62 30, 78 12, 100 10 C 122 12, 138 30, 136 60 C 130 42, 116 34, 100 32 C 84 34, 70 42, 64 60 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Left side long hair */}
    <path
      d="M 64 60 C 60 80, 58 120, 62 155 C 64 135, 65 100, 67 72 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Right side long hair */}
    <path
      d="M 136 60 C 140 80, 140 118, 136 152 C 135 130, 134 98, 132 72 Z"
      fill={`url(#hair-${ID})`}
    />
    {/* Ponytail base */}
    <ellipse cx={100} cy={32} rx={14} ry={8} fill="#006055" />
    {/* Ponytail going back */}
    <path
      d="M 114 32 C 130 28, 148 22, 152 12"
      fill="none"
      stroke={`url(#hair-${ID})`}
      strokeWidth="10"
      strokeLinecap="round"
    />
    {/* Hair tie */}
    <rect x={111} y={28} width={8} height={8} rx={4} fill={COLOR} opacity="0.8" filter={`url(#glow-${ID})`} />
    {/* Hair depth */}
    <path
      d="M 72 54 C 74 32, 85 18, 100 16 C 115 18, 126 32, 128 54"
      fill="none"
      stroke="#003830"
      strokeWidth="7"
      opacity="0.4"
    />
    {/* Teal highlight */}
    <path d="M 90 12 C 86 20, 84 34, 83 48" fill="none" stroke={COLOR} strokeWidth="1.5" opacity="0.5" filter={`url(#glow-${ID})`} />
  </svg>
);

export default Echo;

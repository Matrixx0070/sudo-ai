/**
 * Aria.tsx — Female agent, #f59e0b gold, standing / leadership pose.
 * Elegant updo, confident expression, arms slightly extended / open.
 * ViewBox 200x350.
 */

import React from 'react';
import { AgentDefs, Head, SuitBody, Arm, Leg, lighten } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID    = 'aria';
const COLOR = '#f59e0b';
const SKIN  = '#f0c090';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const ariaAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.01); transform-origin: bottom center; }
  }
  @keyframes auraRotate {
    from { transform: rotate(0deg); transform-origin: 100px 175px; }
    to   { transform: rotate(360deg); transform-origin: 100px 175px; }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .aria         { animation: breathe 3.2s ease-in-out infinite; }
  .aria-ring    { animation: auraRotate 12s linear infinite; }
`;

// ---------------------------------------------------------------------------
// Elegant updo hair
// ---------------------------------------------------------------------------

const UpdoHair: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => (
  <g>
    {/* Base hair surface */}
    <path
      d={`M ${cx - 34} ${cy - 14} C ${cx - 36} ${cy - 44}, ${cx - 18} ${cy - 62}, ${cx} ${cy - 64} C ${cx + 18} ${cy - 62}, ${cx + 36} ${cy - 44}, ${cx + 34} ${cy - 14} C ${cx + 28} ${cy - 34}, ${cx + 14} ${cy - 46}, ${cx} ${cy - 48} C ${cx - 14} ${cy - 46}, ${cx - 28} ${cy - 34}, ${cx - 34} ${cy - 14} Z`}
      fill={`url(#hair-${ID})`}
    />
    {/* Updo bun on top */}
    <ellipse cx={cx} cy={cy - 68} rx={16} ry={12} fill={`url(#hair-${ID})`} />
    <ellipse cx={cx} cy={cy - 72} rx={12} ry={8} fill="#7a5000" />
    {/* Bun wrap lines */}
    <path d={`M ${cx - 14} ${cy - 70} Q ${cx} ${cy - 78} ${cx + 14} ${cy - 70}`} fill="none" stroke="#5a3800" strokeWidth="2.5" opacity="0.6" />
    <path d={`M ${cx - 10} ${cy - 64} Q ${cx} ${cy - 68} ${cx + 10} ${cy - 64}`} fill="none" stroke="#5a3800" strokeWidth="2" opacity="0.4" />
    {/* Gold hairpin */}
    <line x1={cx - 8} y1={cy - 66} x2={cx + 8} y2={cy - 72} stroke={COLOR} strokeWidth="2" opacity="0.9" filter={`url(#glow-${ID})`} />
    <circle cx={cx - 8} cy={cy - 66} r={2.5} fill={COLOR} opacity="0.95" filter={`url(#glow-${ID})`} />
    {/* Side wisps */}
    <path d={`M ${cx - 34} ${cy - 14} C ${cx - 42} ${cy} ${cx - 40} ${cy + 18} ${cx - 36} ${cy + 28}`} fill="none" stroke={`url(#hair-${ID})`} strokeWidth="10" strokeLinecap="round" />
    <path d={`M ${cx + 34} ${cy - 14} C ${cx + 42} ${cy} ${cx + 40} ${cy + 16} ${cx + 36} ${cy + 26}`} fill="none" stroke={`url(#hair-${ID})`} strokeWidth="8" strokeLinecap="round" />
    {/* Elegance depth */}
    <path d={`M ${cx - 20} ${cy - 58} C ${cx - 14} ${cy - 46} ${cx - 12} ${cy - 36} ${cx - 14} ${cy - 22}`} fill="none" stroke="#5a3800" strokeWidth="4" opacity="0.25" />
    {/* Gold highlights */}
    <path d={`M ${cx + 4} ${cy - 62} L ${cx + 6} ${cy - 48}`} fill="none" stroke={lighten(COLOR, 20)} strokeWidth="1.8" opacity="0.6" filter={`url(#glow-${ID})`} />
    <path d={`M ${cx - 10} ${cy - 60} L ${cx - 8} ${cy - 46}`} fill="none" stroke={COLOR} strokeWidth="1.4" opacity="0.5" filter={`url(#glow-${ID})`} />
  </g>
);

// ---------------------------------------------------------------------------
// Leadership halo ring (rotating)
// ---------------------------------------------------------------------------

const HaloRing: React.FC = () => (
  <g className="aria-ring">
    <ellipse
      cx={100} cy={55}
      rx={46} ry={8}
      fill="none"
      stroke={COLOR}
      strokeWidth="1.5"
      strokeDasharray="6 4"
      opacity="0.4"
      filter={`url(#glow-${ID})`}
    />
  </g>
);

// ---------------------------------------------------------------------------
// Aria component
// ---------------------------------------------------------------------------

const Aria: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="aria"
    aria-label="Aria — AI agent"
    role="img"
  >
    <style>{ariaAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura — stronger for leader */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={85} ry={140} />

    {/* Halo ring above head */}
    <HaloRing />

    {/* Legs — confident stance, slightly apart */}
    <Leg id={ID} side="L" hipX={83}  hipY={242} kneeX={78}  kneeY={286} ankleX={76}  ankleY={330} color={COLOR} />
    <Leg id={ID} side="R" hipX={117} hipY={242} kneeX={122} kneeY={286} ankleX={124} ankleY={330} color={COLOR} />

    {/* Suit torso — female */}
    <SuitBody id={ID} cx={100} cy={130} color={COLOR} width={80} height={114} gender="F" />

    {/* Arms — open, welcoming / leadership gesture */}
    <Arm
      id={ID}
      side="L"
      shoulderX={62}
      shoulderY={142}
      elbowX={44}
      elbowY={180}
      wristX={36}
      wristY={208}
      color={COLOR}
      skinTone={SKIN}
    />
    <Arm
      id={ID}
      side="R"
      shoulderX={138}
      shoulderY={142}
      elbowX={156}
      elbowY={180}
      wristX={164}
      wristY={208}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Head — confident smile */}
    <Head
      id={ID}
      cx={100}
      cy={76}
      rx={36}
      ry={42}
      color={COLOR}
      browAngle={5}
      mouthType="smile"
      eyeSpread={13}
    />

    {/* Hair updo */}
    <UpdoHair cx={100} cy={78} />
  </svg>
);

export default Aria;

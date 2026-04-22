/**
 * Vex.tsx — Male agent, #22c55e green, standing / pointing at bug.
 * Short hair + glasses, surprised wide-eyed expression.
 * ViewBox 200x350.
 */

import React from 'react';
import { AgentDefs, Head, SuitBody, Arm, Leg, lighten } from './AgentBase';
import { AgentGlow } from './AgentGlow';

const ID    = 'vex';
const COLOR = '#22c55e';
const SKIN  = '#f0c090';

// ---------------------------------------------------------------------------
// Animation CSS export
// ---------------------------------------------------------------------------

export const vexAnimations = `
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); transform-origin: bottom center; }
    50%       { transform: scaleY(1.01); transform-origin: bottom center; }
  }
  @keyframes point {
    0%, 100% { transform: translate(0, 0); }
    50%       { transform: translate(3px, -2px); }
  }
  @keyframes bugPulse {
    0%, 100% { opacity: 0.9; transform: scale(1); }
    50%       { opacity: 0.6; transform: scale(1.1); }
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
  .vex         { animation: breathe 3s ease-in-out infinite; }
  .vex-arm     { animation: point 1.5s ease-in-out infinite; }
  .vex-bug     { animation: bugPulse 1s ease-in-out infinite; }
`;

// ---------------------------------------------------------------------------
// Glasses overlay (drawn over head)
// ---------------------------------------------------------------------------

const Glasses: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => (
  <g>
    {/* Left lens */}
    <rect x={cx - 28} y={cy - 12} width={22} height={16} rx={5} fill="none" stroke="#4a4a6a" strokeWidth="2" />
    <rect x={cx - 28} y={cy - 12} width={22} height={16} rx={5} fill={COLOR} opacity="0.06" />
    {/* Right lens */}
    <rect x={cx + 6}  y={cy - 12} width={22} height={16} rx={5} fill="none" stroke="#4a4a6a" strokeWidth="2" />
    <rect x={cx + 6}  y={cy - 12} width={22} height={16} rx={5} fill={COLOR} opacity="0.06" />
    {/* Bridge */}
    <line x1={cx - 6} y1={cy - 4} x2={cx + 6} y2={cy - 4} stroke="#4a4a6a" strokeWidth="2" />
    {/* Temple pieces */}
    <line x1={cx - 28} y1={cy - 4} x2={cx - 40} y2={cy - 2} stroke="#4a4a6a" strokeWidth="1.8" strokeLinecap="round" />
    <line x1={cx + 28} y1={cy - 4} x2={cx + 40} y2={cy - 2} stroke="#4a4a6a" strokeWidth="1.8" strokeLinecap="round" />
    {/* Lens glint */}
    <line x1={cx - 24} y1={cy - 10} x2={cx - 20} y2={cy - 6} stroke="white" strokeWidth="1.2" opacity="0.4" strokeLinecap="round" />
    <line x1={cx + 10}  y1={cy - 10} x2={cx + 14} y2={cy - 6} stroke="white" strokeWidth="1.2" opacity="0.4" strokeLinecap="round" />
  </g>
);

// ---------------------------------------------------------------------------
// Bug icon (floating / pointing target)
// ---------------------------------------------------------------------------

const BugIcon: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <g className="vex-bug">
    {/* Bug body */}
    <ellipse cx={x} cy={y} rx={9} ry={11} fill="#ff3333" opacity="0.9" />
    <ellipse cx={x} cy={y - 3} rx={8} ry={7} fill="#cc0000" opacity="0.7" />
    {/* Bug spots */}
    <circle cx={x - 3} cy={y} r={2} fill="#880000" opacity="0.8" />
    <circle cx={x + 3} cy={y + 2} r={2} fill="#880000" opacity="0.8" />
    {/* Bug legs */}
    {[-8, -3, 3].map((dy, i) => (
      <React.Fragment key={i}>
        <line x1={x - 9} y1={y + dy} x2={x - 15} y2={y + dy - 4} stroke="#ff3333" strokeWidth="1.2" strokeLinecap="round" />
        <line x1={x + 9} y1={y + dy} x2={x + 15} y2={y + dy - 4} stroke="#ff3333" strokeWidth="1.2" strokeLinecap="round" />
      </React.Fragment>
    ))}
    {/* Bug eyes */}
    <circle cx={x - 4} cy={y - 8} r={2.5} fill="white" />
    <circle cx={x + 4} cy={y - 8} r={2.5} fill="white" />
    <circle cx={x - 4} cy={y - 8} r={1.2} fill="#000" />
    <circle cx={x + 4} cy={y - 8} r={1.2} fill="#000" />
    {/* Glow */}
    <ellipse cx={x} cy={y} rx={14} ry={16} fill="#ff3333" opacity="0.12" filter={`url(#glow-${ID})`} />
    {/* Error badge */}
    <text x={x + 6} y={y - 12} fontSize="10" fill="#ff0" fontFamily="monospace" opacity="0.95">!</text>
  </g>
);

// ---------------------------------------------------------------------------
// Short hair for Vex
// ---------------------------------------------------------------------------

const ShortHair: React.FC<{ cx: number; cy: number }> = ({ cx, cy }) => (
  <g>
    {/* Cap */}
    <path
      d={`M ${cx - 36} ${cy - 12} C ${cx - 38} ${cy - 42}, ${cx - 20} ${cy - 58}, ${cx} ${cy - 60} C ${cx + 20} ${cy - 58}, ${cx + 38} ${cy - 42}, ${cx + 36} ${cy - 12} C ${cx + 30} ${cy - 30}, ${cx + 14} ${cy - 42}, ${cx} ${cy - 44} C ${cx - 14} ${cy - 42}, ${cx - 30} ${cy - 30}, ${cx - 36} ${cy - 12} Z`}
      fill={`url(#hair-${ID})`}
    />
    {/* Side taper */}
    <path d={`M ${cx - 36} ${cy - 12} Q ${cx - 42} ${cy} ${cx - 40} ${cy + 12}`} fill="none" stroke={`url(#hair-${ID})`} strokeWidth="10" strokeLinecap="round" />
    <path d={`M ${cx + 36} ${cy - 12} Q ${cx + 42} ${cy} ${cx + 40} ${cy + 12}`} fill="none" stroke={`url(#hair-${ID})`} strokeWidth="8" strokeLinecap="round" />
    {/* Depth lines */}
    <path d={`M ${cx - 18} ${cy - 56} C ${cx - 14} ${cy - 44} ${cx - 12} ${cy - 34} ${cx - 14} ${cy - 22}`} fill="none" stroke="#083818" strokeWidth="4" opacity="0.3" />
    {/* Green tint highlight */}
    <path d={`M ${cx + 6} ${cy - 58} L ${cx + 8} ${cy - 44}`} fill="none" stroke={lighten(COLOR, 10)} strokeWidth="1.5" opacity="0.5" filter={`url(#glow-${ID})`} />
  </g>
);

// ---------------------------------------------------------------------------
// Vex component
// ---------------------------------------------------------------------------

const Vex: React.FC = () => (
  <svg
    viewBox="0 0 200 350"
    width="200"
    height="350"
    xmlns="http://www.w3.org/2000/svg"
    className="vex"
    aria-label="Vex — AI agent"
    role="img"
  >
    <style>{vexAnimations}</style>

    <AgentDefs id={ID} color={COLOR} skinTone={SKIN} />

    {/* Ground shadow */}
    <ellipse cx={100} cy={342} rx={52} ry={8} fill={`url(#shadow-${ID})`} />

    {/* Glow aura */}
    <AgentGlow id={ID} color={COLOR} cx={100} cy={175} rx={80} ry={135} />

    {/* Bug floating in the air */}
    <BugIcon x={148} y={112} />

    {/* Legs */}
    <Leg id={ID} side="L" hipX={85}  hipY={242} kneeX={80}  kneeY={286} ankleX={78}  ankleY={330} color={COLOR} />
    <Leg id={ID} side="R" hipX={115} hipY={242} kneeX={120} kneeY={286} ankleX={122} ankleY={330} color={COLOR} />

    {/* Suit torso */}
    <SuitBody id={ID} cx={100} cy={130} color={COLOR} width={88} height={114} gender="M" />

    {/* Left arm — at side / slightly out for balance */}
    <Arm
      id={ID}
      side="L"
      shoulderX={57}
      shoulderY={144}
      elbowX={46}
      elbowY={188}
      wristX={52}
      wristY={220}
      color={COLOR}
      skinTone={SKIN}
    />

    {/* Right arm — extended, pointing at bug */}
    <g className="vex-arm">
      <Arm
        id={ID}
        side="R"
        shoulderX={143}
        shoulderY={144}
        elbowX={158}
        elbowY={172}
        wristX={150}
        wristY={140}
        color={COLOR}
        skinTone={SKIN}
      />
      {/* Pointing finger extension */}
      <line x1={150} y1={140} x2={148} y2={118} stroke={SKIN} strokeWidth="5" strokeLinecap="round" />
    </g>

    {/* Head — surprised expression */}
    <Head
      id={ID}
      cx={100}
      cy={76}
      rx={38}
      ry={44}
      color={COLOR}
      browAngle={-20}
      mouthType="open"
      eyeSpread={15}
    />

    {/* Hair (drawn over face frame, under glasses) */}
    <ShortHair cx={100} cy={78} />

    {/* Glasses overlay */}
    <Glasses cx={100} cy={76} />
  </svg>
);

export default Vex;

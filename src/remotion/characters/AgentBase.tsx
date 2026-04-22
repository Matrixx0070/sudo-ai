/**
 * AgentBase.tsx — Shared SVG building blocks for all SUDO-AI agent characters.
 * Every part uses gradients and filters for premium depth.
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Gender = 'M' | 'F';
export type Pose = 'standing' | 'sitting';

export interface AgentBaseProps {
  color: string;       // accent hex
  skinTone?: string;   // base skin hex, defaults to #f5c5a3
  gender?: Gender;
  pose?: Pose;
  id: string;          // unique per character — namespace SVG defs
}

// ---------------------------------------------------------------------------
// SVG Defs — gradients and filters shared via props
// ---------------------------------------------------------------------------

export const AgentDefs: React.FC<{ id: string; color: string; skinTone: string }> = ({
  id,
  color,
  skinTone,
}) => {
  // Derive a lighter skin tone for highlight side
  const skinHighlight = lighten(skinTone, 20);
  const skinShadow = darken(skinTone, 15);
  const suitShadow = '#0d0d1f';
  const colorDim = dimColor(color);

  return (
    <defs>
      {/* Glow filter */}
      <filter id={`glow-${id}`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>

      {/* Soft outer glow for aura */}
      <filter id={`aura-${id}`} x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="18" result="blur" />
      </filter>

      {/* Iris glow filter */}
      <filter id={`iris-glow-${id}`} x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="2.5" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>

      {/* Skin gradient — light left, shadow right */}
      <linearGradient id={`skin-${id}`} x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stopColor={skinHighlight} />
        <stop offset="55%" stopColor={skinTone} />
        <stop offset="100%" stopColor={skinShadow} />
      </linearGradient>

      {/* Skin vertical gradient for forehead */}
      <linearGradient id={`skinV-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={lighten(skinTone, 10)} />
        <stop offset="100%" stopColor={skinShadow} />
      </linearGradient>

      {/* Suit gradient — slightly lighter base so accents pop */}
      <linearGradient id={`suit-${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#2e2e4a" />
        <stop offset="50%" stopColor="#252540" />
        <stop offset="100%" stopColor={suitShadow} />
      </linearGradient>

      {/* Suit pants gradient */}
      <linearGradient id={`pants-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#161628" />
        <stop offset="100%" stopColor="#0d0d1a" />
      </linearGradient>

      {/* Accent glow gradient */}
      <linearGradient id={`accent-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={color} stopOpacity="0.9" />
        <stop offset="100%" stopColor={colorDim} stopOpacity="0.5" />
      </linearGradient>

      {/* Radial aura gradient — stronger */}
      <radialGradient id={`aura-grad-${id}`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor={color} stopOpacity="0.45" />
        <stop offset="70%" stopColor={color} stopOpacity="0.20" />
        <stop offset="100%" stopColor={color} stopOpacity="0" />
      </radialGradient>

      {/* Iris gradient */}
      <radialGradient id={`iris-${id}`} cx="35%" cy="35%" r="65%">
        <stop offset="0%" stopColor={lighten(color, 30)} />
        <stop offset="60%" stopColor={color} />
        <stop offset="100%" stopColor={darken(color, 20)} />
      </radialGradient>

      {/* Hair gradient — matches agent accent color */}
      <linearGradient id={`hair-${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor={lighten(color, 25)} />
        <stop offset="50%" stopColor={color} />
        <stop offset="100%" stopColor={darken(color, 25)} />
      </linearGradient>

      {/* Shoe gradient */}
      <linearGradient id={`shoe-${id}`} x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#2a2a3a" />
        <stop offset="100%" stopColor="#0d0d18" />
      </linearGradient>

      {/* Ground shadow */}
      <radialGradient id={`shadow-${id}`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#000000" stopOpacity="0.6" />
        <stop offset="100%" stopColor="#000000" stopOpacity="0" />
      </radialGradient>

      {/* Ground shadow — outer ambient layer */}
      <radialGradient id={`shadow2-${id}`} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#000000" stopOpacity="0.25" />
        <stop offset="100%" stopColor="#000000" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
};

// ---------------------------------------------------------------------------
// GlowAura — radial gradient ellipse behind the character
// ---------------------------------------------------------------------------

export const GlowAura: React.FC<{ id: string; cx: number; cy: number; rx: number; ry: number }> = ({
  id,
  cx,
  cy,
  rx,
  ry,
}) => (
  <ellipse
    cx={cx}
    cy={cy}
    rx={rx}
    ry={ry}
    fill={`url(#aura-grad-${id})`}
    style={{
      animation: 'glowPulse 3s ease-in-out infinite',
    }}
  />
);

// ---------------------------------------------------------------------------
// Head component
// ---------------------------------------------------------------------------

export interface HeadProps {
  id: string;
  cx: number;
  cy: number;
  rx?: number;
  ry?: number;
  color: string;
  // eye config
  eyeLY?: number;   // left eye center Y
  eyeRY?: number;
  eyeSpread?: number;
  browAngle?: number; // positive = angry, negative = sad/surprised
  mouthType?: 'smile' | 'neutral' | 'slight' | 'open' | 'smirk';
  showNose?: boolean;
}

export const Head: React.FC<HeadProps> = ({
  id,
  cx,
  cy,
  rx = 38,
  ry = 44,
  color,
  eyeLY,
  eyeRY,
  eyeSpread = 14,
  browAngle = 0,
  mouthType = 'slight',
  showNose = true,
}) => {
  const ely = eyeLY ?? cy - 6;
  const ery = eyeRY ?? cy - 6;
  const lx = cx - eyeSpread;
  const rx2 = cx + eyeSpread;

  return (
    <g>
      {/* Neck */}
      <rect
        x={cx - 10}
        y={cy + ry - 4}
        width={20}
        height={18}
        fill={`url(#skin-${id})`}
        rx={4}
      />

      {/* Face oval */}
      <ellipse
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        fill={`url(#skin-${id})`}
      />

      {/* Subtle face shading */}
      <ellipse
        cx={cx + rx * 0.3}
        cy={cy + ry * 0.1}
        rx={rx * 0.45}
        ry={ry * 0.5}
        fill="rgba(0,0,0,0.06)"
      />

      {/* Chin highlight */}
      <ellipse
        cx={cx - 4}
        cy={cy + ry * 0.55}
        rx={8}
        ry={5}
        fill="rgba(255,255,255,0.08)"
      />

      {showNose && (
        <g>
          {/* Nose */}
          <ellipse cx={cx} cy={cy + 8} rx={4} ry={3} fill="rgba(0,0,0,0.1)" />
          <ellipse cx={cx - 4} cy={cy + 10} rx={2.5} ry={2} fill="rgba(0,0,0,0.12)" />
          <ellipse cx={cx + 4} cy={cy + 10} rx={2.5} ry={2} fill="rgba(0,0,0,0.12)" />
        </g>
      )}

      {/* Left eyebrow */}
      <EyeBrow cx={lx} cy={ely - 14} angle={-browAngle} id={id} />
      {/* Right eyebrow */}
      <EyeBrow cx={rx2} cy={ery - 14} angle={browAngle} id={id} />

      {/* Left eye */}
      <Eye cx={lx} cy={ely} id={id} color={color} />
      {/* Right eye */}
      <Eye cx={rx2} cy={ery} id={id} color={color} />

      {/* Mouth */}
      <Mouth cx={cx} cy={cy + 22} type={mouthType} />

      {/* Ear left */}
      <ellipse cx={cx - rx + 2} cy={cy + 2} rx={5} ry={8} fill={`url(#skin-${id})`} />
      {/* Ear right */}
      <ellipse cx={cx + rx - 2} cy={cy + 2} rx={5} ry={8} fill={`url(#skin-${id})`} />
    </g>
  );
};

// ---------------------------------------------------------------------------
// Eye
// ---------------------------------------------------------------------------

const Eye: React.FC<{ cx: number; cy: number; id: string; color: string }> = ({
  cx,
  cy,
  id,
  color: _color,
}) => (
  <g>
    {/* Sclera */}
    <ellipse cx={cx} cy={cy} rx={9} ry={7} fill="white" />
    {/* Iris with glow */}
    <circle cx={cx} cy={cy} r={7} fill={`url(#iris-${id})`} filter={`url(#iris-glow-${id})`} />
    {/* Pupil */}
    <circle cx={cx} cy={cy} r={3.2} fill="#0a0a14" />
    {/* Catch light */}
    <circle cx={cx + 2} cy={cy - 2} r={2.5} fill="white" opacity="0.98" />
    {/* Eyelid top */}
    <path
      d={`M ${cx - 9} ${cy} Q ${cx} ${cy - 9} ${cx + 9} ${cy}`}
      fill="none"
      stroke="#2a1a0a"
      strokeWidth="1.5"
    />
    {/* Lashes */}
    <line x1={cx - 8} y1={cy - 1} x2={cx - 11} y2={cy - 5} stroke="#1a0a0a" strokeWidth="1.2" strokeLinecap="round" />
    <line x1={cx - 4} y1={cy - 6} x2={cx - 4} y2={cy - 10} stroke="#1a0a0a" strokeWidth="1.2" strokeLinecap="round" />
    <line x1={cx + 2} y1={cy - 7} x2={cx + 3} y2={cy - 11} stroke="#1a0a0a" strokeWidth="1.2" strokeLinecap="round" />
    <line x1={cx + 7} y1={cy - 3} x2={cx + 10} y2={cy - 6} stroke="#1a0a0a" strokeWidth="1.2" strokeLinecap="round" />
  </g>
);

// ---------------------------------------------------------------------------
// Eyebrow
// ---------------------------------------------------------------------------

const EyeBrow: React.FC<{ cx: number; cy: number; angle: number; id: string }> = ({
  cx,
  cy,
  angle,
}) => {
  const dx = Math.cos((angle * Math.PI) / 180) * 10;
  const dy = Math.sin((angle * Math.PI) / 180) * 10;
  return (
    <path
      d={`M ${cx - dx} ${cy + dy} Q ${cx} ${cy - 4} ${cx + dx} ${cy - dy}`}
      fill="none"
      stroke="#1a0a04"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  );
};

// ---------------------------------------------------------------------------
// Mouth
// ---------------------------------------------------------------------------

const Mouth: React.FC<{ cx: number; cy: number; type: HeadProps['mouthType'] }> = ({
  cx,
  cy,
  type,
}) => {
  switch (type) {
    case 'smile':
      return (
        <path
          d={`M ${cx - 12} ${cy} Q ${cx} ${cy + 10} ${cx + 12} ${cy}`}
          fill="none"
          stroke="#8b4513"
          strokeWidth="2"
          strokeLinecap="round"
        />
      );
    case 'open':
      return (
        <g>
          <ellipse cx={cx} cy={cy + 3} rx={9} ry={6} fill="#5a2010" />
          <ellipse cx={cx} cy={cy + 1} rx={8} ry={3} fill="#c0392b" />
          <ellipse cx={cx} cy={cy - 1} rx={9} ry={2} fill="#d4956a" />
        </g>
      );
    case 'smirk':
      return (
        <path
          d={`M ${cx - 8} ${cy + 2} Q ${cx + 2} ${cy + 8} ${cx + 12} ${cy - 2}`}
          fill="none"
          stroke="#8b4513"
          strokeWidth="2"
          strokeLinecap="round"
        />
      );
    case 'neutral':
      return (
        <line
          x1={cx - 10}
          y1={cy + 2}
          x2={cx + 10}
          y2={cy + 2}
          stroke="#8b4513"
          strokeWidth="2"
          strokeLinecap="round"
        />
      );
    case 'slight':
    default:
      return (
        <path
          d={`M ${cx - 10} ${cy + 2} Q ${cx} ${cy + 8} ${cx + 10} ${cy + 2}`}
          fill="none"
          stroke="#8b4513"
          strokeWidth="2"
          strokeLinecap="round"
        />
      );
  }
};

// ---------------------------------------------------------------------------
// SuitBody
// ---------------------------------------------------------------------------

export interface SuitBodyProps {
  id: string;
  cx: number;
  cy: number;         // top of torso
  color: string;
  width?: number;
  height?: number;
  gender?: Gender;
}

export const SuitBody: React.FC<SuitBodyProps> = ({
  id,
  cx,
  cy,
  color,
  width = 80,
  height = 100,
  gender = 'M',
}) => {
  const hw = width / 2;
  const shoulderW = gender === 'F' ? hw * 0.85 : hw;

  return (
    <g>
      {/* Shirt / inner white */}
      <path
        d={`M ${cx - 14} ${cy + 8} L ${cx - 8} ${cy + height * 0.9} L ${cx + 8} ${cy + height * 0.9} L ${cx + 14} ${cy + 8} Z`}
        fill="#e8e8f0"
        opacity="0.9"
      />

      {/* Suit jacket main */}
      <path
        d={`
          M ${cx - shoulderW} ${cy}
          C ${cx - shoulderW - 8} ${cy + 10}, ${cx - shoulderW - 6} ${cy + height * 0.5}, ${cx - hw * 0.7} ${cy + height}
          L ${cx + hw * 0.7} ${cy + height}
          C ${cx + shoulderW + 6} ${cy + height * 0.5}, ${cx + shoulderW + 8} ${cy + 10}, ${cx + shoulderW} ${cy}
          Z
        `}
        fill={`url(#suit-${id})`}
      />

      {/* Left lapel */}
      <path
        d={`M ${cx - 14} ${cy + 8} L ${cx - shoulderW} ${cy} L ${cx - shoulderW * 0.5} ${cy + 30} Z`}
        fill="#1e1e34"
        opacity="0.9"
      />
      {/* Right lapel */}
      <path
        d={`M ${cx + 14} ${cy + 8} L ${cx + shoulderW} ${cy} L ${cx + shoulderW * 0.5} ${cy + 30} Z`}
        fill="#1e1e34"
        opacity="0.9"
      />

      {/* Subtle colored overlay on jacket */}
      <path
        d={`
          M ${cx - shoulderW} ${cy}
          C ${cx - shoulderW - 8} ${cy + 10}, ${cx - shoulderW - 6} ${cy + height * 0.5}, ${cx - hw * 0.7} ${cy + height}
          L ${cx + hw * 0.7} ${cy + height}
          C ${cx + shoulderW + 6} ${cy + height * 0.5}, ${cx + shoulderW + 8} ${cy + 10}, ${cx + shoulderW} ${cy}
          Z
        `}
        fill={color}
        opacity="0.10"
      />

      {/* Glowing center seam */}
      <line
        x1={cx}
        y1={cy + 8}
        x2={cx}
        y2={cy + height * 0.85}
        stroke={color}
        strokeWidth="2"
        opacity="0.8"
        filter={`url(#glow-${id})`}
      />

      {/* Accent trim left edge */}
      <path
        d={`M ${cx - shoulderW} ${cy} C ${cx - shoulderW - 6} ${cy + height * 0.4}, ${cx - hw * 0.85} ${cy + height * 0.7}, ${cx - hw * 0.7} ${cy + height}`}
        fill="none"
        stroke={color}
        strokeWidth="2"
        opacity="0.75"
        filter={`url(#glow-${id})`}
      />
      {/* Accent trim right edge */}
      <path
        d={`M ${cx + shoulderW} ${cy} C ${cx + shoulderW + 6} ${cy + height * 0.4}, ${cx + hw * 0.85} ${cy + height * 0.7}, ${cx + hw * 0.7} ${cy + height}`}
        fill="none"
        stroke={color}
        strokeWidth="2"
        opacity="0.75"
        filter={`url(#glow-${id})`}
      />

      {/* Shoulder seam left */}
      <line
        x1={cx - shoulderW}
        y1={cy}
        x2={cx - shoulderW * 0.6}
        y2={cy + 22}
        stroke={color}
        strokeWidth="1.5"
        opacity="0.55"
        filter={`url(#glow-${id})`}
      />
      {/* Shoulder seam right */}
      <line
        x1={cx + shoulderW}
        y1={cy}
        x2={cx + shoulderW * 0.6}
        y2={cy + 22}
        stroke={color}
        strokeWidth="1.5"
        opacity="0.55"
        filter={`url(#glow-${id})`}
      />

      {/* Chest pocket accent */}
      <line
        x1={cx - hw * 0.55}
        y1={cy + height * 0.22}
        x2={cx - hw * 0.55}
        y2={cy + height * 0.35}
        stroke={color}
        strokeWidth="1.5"
        opacity="0.45"
        filter={`url(#glow-${id})`}
      />

      {/* Button */}
      <circle cx={cx} cy={cy + 55} r={3.5} fill={color} opacity="0.9" filter={`url(#glow-${id})`} />
      <circle cx={cx} cy={cy + 70} r={3.5} fill={color} opacity="0.80" filter={`url(#glow-${id})`} />
    </g>
  );
};

// ---------------------------------------------------------------------------
// Arm
// ---------------------------------------------------------------------------

export interface ArmProps {
  id: string;
  side: 'L' | 'R';
  shoulderX: number;
  shoulderY: number;
  elbowX: number;
  elbowY: number;
  wristX: number;
  wristY: number;
  color: string;
  skinTone: string;
}

export const Arm: React.FC<ArmProps> = ({
  id,
  side: _side,
  shoulderX,
  shoulderY,
  elbowX,
  elbowY,
  wristX,
  wristY,
  color,
  skinTone,
}) => {
  const skinShadow = darken(skinTone, 10);
  return (
    <g>
      {/* Upper arm */}
      <path
        d={`M ${shoulderX} ${shoulderY} Q ${elbowX - 4} ${elbowY - 8} ${elbowX} ${elbowY}`}
        fill="none"
        stroke={`url(#suit-${id})`}
        strokeWidth="18"
        strokeLinecap="round"
      />
      {/* Upper arm accent */}
      <path
        d={`M ${shoulderX} ${shoulderY} Q ${elbowX - 4} ${elbowY - 8} ${elbowX} ${elbowY}`}
        fill="none"
        stroke={color}
        strokeWidth="1"
        opacity="0.4"
        strokeLinecap="round"
        filter={`url(#glow-${id})`}
      />

      {/* Lower arm / sleeve */}
      <path
        d={`M ${elbowX} ${elbowY} Q ${wristX - 2} ${wristY - 6} ${wristX} ${wristY}`}
        fill="none"
        stroke={`url(#suit-${id})`}
        strokeWidth="16"
        strokeLinecap="round"
      />

      {/* Colored cuff */}
      <circle
        cx={wristX}
        cy={wristY}
        r={9}
        fill="#1a1a2e"
        stroke={color}
        strokeWidth="2"
        filter={`url(#glow-${id})`}
      />

      {/* Hand */}
      <ellipse
        cx={wristX}
        cy={wristY + 10}
        rx={7}
        ry={9}
        fill={skinTone}
      />
      {/* Finger hints */}
      <line x1={wristX - 4} y1={wristY + 16} x2={wristX - 5} y2={wristY + 22} stroke={skinShadow} strokeWidth="2" strokeLinecap="round" />
      <line x1={wristX - 1} y1={wristY + 18} x2={wristX - 1} y2={wristY + 24} stroke={skinShadow} strokeWidth="2" strokeLinecap="round" />
      <line x1={wristX + 2} y1={wristY + 18} x2={wristX + 2} y2={wristY + 24} stroke={skinShadow} strokeWidth="2" strokeLinecap="round" />
      <line x1={wristX + 5} y1={wristY + 17} x2={wristX + 6} y2={wristY + 22} stroke={skinShadow} strokeWidth="2" strokeLinecap="round" />
    </g>
  );
};

// ---------------------------------------------------------------------------
// Leg
// ---------------------------------------------------------------------------

export interface LegProps {
  id: string;
  side: 'L' | 'R';
  hipX: number;
  hipY: number;
  kneeX: number;
  kneeY: number;
  ankleX: number;
  ankleY: number;
  color: string;
}

export const Leg: React.FC<LegProps> = ({
  id,
  side: _side,
  hipX,
  hipY,
  kneeX,
  kneeY,
  ankleX,
  ankleY,
  color,
}) => (
  <g>
    {/* Upper leg */}
    <path
      d={`M ${hipX} ${hipY} Q ${kneeX - 2} ${kneeY - 10} ${kneeX} ${kneeY}`}
      fill="none"
      stroke={`url(#pants-${id})`}
      strokeWidth="22"
      strokeLinecap="round"
    />
    {/* Accent stripe */}
    <path
      d={`M ${hipX + 6} ${hipY} Q ${kneeX + 4} ${kneeY - 10} ${kneeX + 4} ${kneeY}`}
      fill="none"
      stroke={color}
      strokeWidth="1"
      opacity="0.4"
      strokeLinecap="round"
      filter={`url(#glow-${id})`}
    />

    {/* Lower leg */}
    <path
      d={`M ${kneeX} ${kneeY} Q ${ankleX - 2} ${ankleY - 8} ${ankleX} ${ankleY}`}
      fill="none"
      stroke={`url(#pants-${id})`}
      strokeWidth="20"
      strokeLinecap="round"
    />

    {/* Shoe */}
    <ellipse
      cx={ankleX + 4}
      cy={ankleY + 8}
      rx={16}
      ry={8}
      fill={`url(#shoe-${id})`}
    />
    <ellipse
      cx={ankleX}
      cy={ankleY + 6}
      rx={10}
      ry={6}
      fill="#1e1e30"
    />
  </g>
);

// ---------------------------------------------------------------------------
// Helper color functions (simple hex manipulation)
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return [r, g, b];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + amount, g + amount, b + amount);
}

export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r - amount, g - amount, b - amount);
}

function dimColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(Math.round(r * 0.6), Math.round(g * 0.6), Math.round(b * 0.6));
}

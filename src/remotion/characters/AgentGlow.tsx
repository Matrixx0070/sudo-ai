/**
 * AgentGlow.tsx — Animated aura ellipse behind each agent character.
 * Used as a background layer in every character SVG.
 */

import React from 'react';

export interface AgentGlowProps {
  color: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  id: string;
}

/**
 * Inline keyframes injected once per page via a <style> tag.
 * Each character's SVG wraps this component.
 */
export const glowKeyframes = `
  @keyframes glowPulse {
    0%, 100% { opacity: 0.25; }
    50%       { opacity: 0.50; }
  }
`;

export const AgentGlow: React.FC<AgentGlowProps> = ({ color, cx, cy, rx, ry, id }) => (
  <g>
    {/* Inject keyframe once — browsers deduplicate identical style content */}
    <style>{glowKeyframes}</style>

    {/* Outer soft haze */}
    <ellipse
      cx={cx}
      cy={cy}
      rx={rx * 1.6}
      ry={ry * 1.6}
      style={{
        fill: color,
        opacity: 0.14,
        filter: `blur(28px)`,
        animation: 'glowPulse 3.2s ease-in-out infinite',
      }}
    />

    {/* Inner radial glow */}
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

    {/* Second inner glow — tighter, brighter core */}
    <ellipse
      cx={cx}
      cy={cy}
      rx={rx * 0.55}
      ry={ry * 0.55}
      style={{
        fill: color,
        opacity: 0.20,
        filter: `blur(14px)`,
        animation: 'glowPulse 2.6s ease-in-out infinite',
      }}
    />
  </g>
);

export default AgentGlow;

import React from 'react';

interface GlassWallProps {
  /** Horizontal position as a percentage of the scene container width */
  left: number;
  /** Vertical position as a percentage of the scene container height */
  top: number;
  /** Width as a percentage of the scene container width */
  width: number;
  /** Optional CSS rotation in degrees (default: 0) */
  rotation?: number;
}

/**
 * GlassWall
 *
 * Renders a single glass-wall divider between rooms at the scene coordinate
 * level. Sits at z-index 3 — above floor tiles (z 1–2) but below furniture
 * and agents (z 4+).
 *
 * - opacity: 0.7 for a translucent glass appearance
 * - pointer-events: none — purely decorative, never intercepts clicks
 * - aria-hidden: true — decorative image, screen readers skip it
 */
export function GlassWall({
  left,
  top,
  width,
  rotation = 0,
}: GlassWallProps): React.ReactElement {
  return (
    <img
      src="/office/structure/glass-wall.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: 'auto',
        zIndex: 3,
        opacity: 0.7,
        pointerEvents: 'none',
        transform: rotation !== 0 ? `rotate(${rotation}deg)` : undefined,
        display: 'block',
      }}
    />
  );
}

export default GlassWall;

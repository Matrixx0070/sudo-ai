/**
 * ParticleOverlay
 *
 * Renders 40 pure-CSS floating particle divs over the office.
 * No canvas, no WebGL — only CSS keyframe animations.
 * Colors are sampled from the crystal theme palette.
 */

import React, { useMemo } from 'react';
import './crystal-office.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Particle {
  id: number;
  x: number;       // % from left
  y: number;       // % from top (starting position)
  size: number;    // px diameter
  color: string;
  duration: number; // seconds
  delay: number;    // seconds
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARTICLE_COUNT = 40;

const COLORS = [
  'rgba(59,130,246,0.45)',   // blue
  'rgba(168,85,247,0.40)',   // purple
  'rgba(20,184,166,0.40)',   // teal
  'rgba(59,130,246,0.30)',   // blue lighter
  'rgba(139,92,246,0.35)',   // violet
];

// ---------------------------------------------------------------------------
// Deterministic seeded pseudo-random so particles are stable on re-render
// ---------------------------------------------------------------------------

function seededRandom(seed: number): number {
  // LCG — good enough for cosmetic use
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

function buildParticles(): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const r0 = seededRandom(i * 7 + 0);
    const r1 = seededRandom(i * 7 + 1);
    const r2 = seededRandom(i * 7 + 2);
    const r3 = seededRandom(i * 7 + 3);
    const r4 = seededRandom(i * 7 + 4);
    const r5 = seededRandom(i * 7 + 5);

    particles.push({
      id: i,
      x: r0 * 100,
      y: 20 + r1 * 70,    // keep particles in the lower 70% to match floor
      size: 2 + r2 * 4,   // 2-6 px
      color: COLORS[Math.floor(r3 * COLORS.length)],
      duration: 3 + r4 * 5, // 3-8 s
      delay: -(r5 * 8),     // negative delay = already mid-flight on mount
    });
  }
  return particles;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ParticleOverlay(): React.ReactElement {
  // Memoised so particles don't regenerate on parent re-renders
  const particles = useMemo<Particle[]>(buildParticles, []);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 2,
        overflow: 'hidden',
      }}
    >
      {particles.map((p) => (
        <div
          key={p.id}
          className="crystal-particle"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            background: p.color,
            boxShadow: `0 0 ${p.size * 2}px ${p.color}`,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

export default ParticleOverlay;

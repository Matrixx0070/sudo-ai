import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AgentState } from '../types.js';

interface AgentAnimationResult {
  ref: React.RefObject<THREE.Group | null>;
}

export function useAgentAnimation(state: AgentState): AgentAnimationResult {
  const ref = useRef<THREE.Group | null>(null);
  const timeRef = useRef<number>(0);

  useFrame((_, delta) => {
    if (!ref.current) return;
    timeRef.current += delta;
    const t = timeRef.current;

    switch (state) {
      case 'idle': {
        // Gentle vertical bob — 0.03 amplitude, slow
        ref.current.position.y = Math.sin(t * 1.2) * 0.03;
        ref.current.rotation.x = 0;
        ref.current.rotation.z = 0;
        break;
      }
      case 'working': {
        // Subtle forward lean — rotation.x oscillates slightly
        ref.current.position.y = 0;
        ref.current.rotation.x = Math.sin(t * 2.0) * 0.04;
        ref.current.rotation.z = 0;
        break;
      }
      case 'thinking': {
        // Slow head rotation side to side — use z rotation on whole group
        ref.current.position.y = 0;
        ref.current.rotation.x = 0;
        ref.current.rotation.z = Math.sin(t * 0.8) * 0.08;
        break;
      }
      case 'error': {
        // Rapid horizontal shake — small x position oscillation
        ref.current.position.y = 0;
        ref.current.rotation.x = 0;
        ref.current.rotation.z = 0;
        ref.current.position.x = Math.sin(t * 25) * 0.06;
        break;
      }
      case 'walking': {
        // Bob faster than idle
        ref.current.position.y = Math.sin(t * 4.0) * 0.05;
        ref.current.rotation.x = 0;
        ref.current.rotation.z = 0;
        break;
      }
      case 'talking': {
        // Gentle sway — mild z rotation
        ref.current.position.y = 0;
        ref.current.rotation.x = 0;
        ref.current.rotation.z = Math.sin(t * 3.0) * 0.03;
        break;
      }
      case 'break': {
        // No animation — still
        ref.current.position.y = 0;
        ref.current.rotation.x = 0;
        ref.current.rotation.z = 0;
        break;
      }
      default: {
        ref.current.position.y = 0;
        ref.current.rotation.x = 0;
        ref.current.rotation.z = 0;
        break;
      }
    }

    // Reset x-drift when not in error state
    if (state !== 'error') {
      ref.current.position.x = THREE.MathUtils.lerp(ref.current.position.x, 0, 0.2);
    }
  });

  return { ref };
}

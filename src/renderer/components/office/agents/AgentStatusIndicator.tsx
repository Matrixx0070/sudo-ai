import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AgentState } from '../types.js';

interface AgentStatusIndicatorProps {
  state: AgentState;
  color: string;
}

const STATE_COLORS: Record<AgentState, string> = {
  idle: '#6b7280',
  working: '#22c55e',
  thinking: '#eab308',
  talking: '#3b82f6',
  error: '#ef4444',
  break: '#a855f7',
  walking: '#14b8a6',
};

export function AgentStatusIndicator({ state }: AgentStatusIndicatorProps): React.ReactElement {
  const ringRef = useRef<THREE.Mesh>(null);
  const phaseRef = useRef<number>(0);

  useFrame((_, delta) => {
    if (!ringRef.current) return;

    phaseRef.current += delta;

    // Rotate ring around Y axis
    ringRef.current.rotation.y += delta * 1.5;

    // Pulse opacity for 'thinking'
    const mat = ringRef.current.material as THREE.MeshStandardMaterial;
    if (state === 'thinking') {
      mat.opacity = 0.4 + 0.5 * Math.abs(Math.sin(phaseRef.current * 2));
    } else {
      mat.opacity = 0.85;
    }
  });

  const ringColor = STATE_COLORS[state];

  return (
    <mesh
      ref={ringRef}
      position={[0, 0.05, 0]}
      rotation={[Math.PI / 2, 0, 0]}
    >
      <ringGeometry args={[0.45, 0.55, 32]} />
      <meshStandardMaterial
        color={ringColor}
        transparent
        opacity={0.85}
        side={THREE.DoubleSide}
        roughness={0.3}
        metalness={0.4}
      />
    </mesh>
  );
}

export default AgentStatusIndicator;

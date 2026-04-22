import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AgentState } from '../types.js';

interface AgentCharacterProps {
  color: string;
  state: AgentState;
}

export function AgentCharacter({ color, state }: AgentCharacterProps): React.ReactElement {
  const torsoRef = useRef<THREE.Mesh>(null);
  const headRef = useRef<THREE.Mesh>(null);
  const errorPhaseRef = useRef<number>(0);

  useFrame((_, delta) => {
    if (state === 'error') {
      errorPhaseRef.current += delta * 20;
      const flash = Math.sin(errorPhaseRef.current) > 0 ? 0.8 : 0;
      if (torsoRef.current) {
        (torsoRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = flash;
      }
      if (headRef.current) {
        (headRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = flash;
      }
    } else {
      errorPhaseRef.current = 0;
      if (torsoRef.current) {
        (torsoRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
      }
      if (headRef.current) {
        (headRef.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
      }
    }
  });

  return (
    <>
      {/* Torso: Box 0.6 x 0.8 x 0.4, centered at y=0.4 */}
      <mesh ref={torsoRef} position={[0, 0.4, 0]} castShadow>
        <boxGeometry args={[0.6, 0.8, 0.4]} />
        <meshStandardMaterial
          color={color}
          emissive="#ff0000"
          emissiveIntensity={0}
          roughness={0.4}
          metalness={0.1}
        />
      </mesh>

      {/* Head: Sphere radius=0.25 at y=1.05 */}
      <mesh ref={headRef} position={[0, 1.05, 0]} castShadow>
        <sphereGeometry args={[0.25, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive="#ff0000"
          emissiveIntensity={0}
          roughness={0.4}
          metalness={0.1}
        />
      </mesh>
    </>
  );
}

export default AgentCharacter;

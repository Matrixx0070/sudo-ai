import React from 'react';
import { ThreeElements } from '@react-three/fiber';

interface ChairProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

export function Chair({ position = [0, 0, 0], rotation = [0, 0, 0], color = '#1f2937' }: ChairProps) {
  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Seat */}
      <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.4, 0.05, 0.4]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.05} />
      </mesh>

      {/* Back */}
      <mesh position={[0, 0.7, -0.17]} castShadow>
        <boxGeometry args={[0.4, 0.4, 0.05]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.05} />
      </mesh>

      {/* Base stem (cylinder) */}
      <mesh position={[0, 0.22, 0]} castShadow>
        <cylinderGeometry args={[0.15, 0.15, 0.45, 12]} />
        <meshStandardMaterial color='#374151' roughness={0.4} metalness={0.5} />
      </mesh>
    </group>
  );
}

export default Chair;

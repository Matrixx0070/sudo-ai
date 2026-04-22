import React from 'react';
import { ThreeElements } from '@react-three/fiber';

interface DeskProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

export function Desk({ position = [0, 0, 0], rotation = [0, 0, 0], color = '#374151' }: DeskProps) {
  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Table top */}
      <mesh position={[0, 0.7, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.2, 0.05, 0.6]} />
        <meshStandardMaterial color={color} roughness={0.6} metalness={0.1} />
      </mesh>

      {/* Front-left leg */}
      <mesh position={[-0.55, 0.35, 0.25]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.7, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
      </mesh>

      {/* Front-right leg */}
      <mesh position={[0.55, 0.35, 0.25]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.7, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
      </mesh>

      {/* Back-left leg */}
      <mesh position={[-0.55, 0.35, -0.25]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.7, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
      </mesh>

      {/* Back-right leg */}
      <mesh position={[0.55, 0.35, -0.25]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.7, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
      </mesh>
    </group>
  );
}

export default Desk;

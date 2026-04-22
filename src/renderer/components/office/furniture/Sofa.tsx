import React from 'react';
import { ThreeElements } from '@react-three/fiber';

interface SofaProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}

export function Sofa({ position = [0, 0, 0], rotation = [0, 0, 0], color = '#4b5563' }: SofaProps) {
  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Seat cushion */}
      <mesh position={[0, 0.35, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.5, 0.3, 0.6]} />
        <meshStandardMaterial color={color} roughness={0.9} metalness={0.0} />
      </mesh>

      {/* Back rest */}
      <mesh position={[0, 0.55, -0.22]} castShadow>
        <boxGeometry args={[1.5, 0.4, 0.15]} />
        <meshStandardMaterial color={color} roughness={0.9} metalness={0.0} />
      </mesh>

      {/* Left arm */}
      <mesh position={[-0.67, 0.5, 0]} castShadow>
        <boxGeometry args={[0.15, 0.25, 0.6]} />
        <meshStandardMaterial color={color} roughness={0.9} metalness={0.0} />
      </mesh>

      {/* Right arm */}
      <mesh position={[0.67, 0.5, 0]} castShadow>
        <boxGeometry args={[0.15, 0.25, 0.6]} />
        <meshStandardMaterial color={color} roughness={0.9} metalness={0.0} />
      </mesh>

      {/* Base / feet — slight bottom to lift sofa off floor */}
      <mesh position={[0, 0.06, 0]}>
        <boxGeometry args={[1.5, 0.12, 0.58]} />
        <meshStandardMaterial color='#374151' roughness={0.5} metalness={0.2} />
      </mesh>
    </group>
  );
}

export default Sofa;

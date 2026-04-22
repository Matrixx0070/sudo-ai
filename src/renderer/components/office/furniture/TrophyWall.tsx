import React from 'react';
import { ThreeElements } from '@react-three/fiber';

interface TrophyWallProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
}

// A single trophy: cylinder base + sphere top
interface TrophyProps {
  position: [number, number, number];
}

function Trophy({ position }: TrophyProps) {
  return (
    <group position={position}>
      {/* Pedestal base */}
      <mesh position={[0, 0.06, 0]}>
        <boxGeometry args={[0.12, 0.06, 0.12]} />
        <meshStandardMaterial color='#92400e' roughness={0.5} metalness={0.3} />
      </mesh>

      {/* Stem */}
      <mesh position={[0, 0.16, 0]}>
        <cylinderGeometry args={[0.025, 0.03, 0.14, 8]} />
        <meshStandardMaterial color='#f59e0b' roughness={0.3} metalness={0.7} />
      </mesh>

      {/* Cup bowl */}
      <mesh position={[0, 0.27, 0]}>
        <cylinderGeometry args={[0.06, 0.03, 0.1, 12]} />
        <meshStandardMaterial color='#f59e0b' roughness={0.3} metalness={0.8} />
      </mesh>

      {/* Top sphere */}
      <mesh position={[0, 0.36, 0]}>
        <sphereGeometry args={[0.04, 10, 10]} />
        <meshStandardMaterial color='#fbbf24' roughness={0.2} metalness={0.9} />
      </mesh>
    </group>
  );
}

export function TrophyWall({ position = [0, 0, 0], rotation = [0, 0, 0] }: TrophyWallProps) {
  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Shelf planks — 3 levels */}
      {([0.5, 1.0, 1.5] as number[]).map((y, i) => (
        <mesh key={i} position={[0, y, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.8, 0.05, 0.25]} />
          <meshStandardMaterial color='#44403c' roughness={0.6} metalness={0.1} />
        </mesh>
      ))}

      {/* Trophies on bottom shelf */}
      <Trophy position={[-0.6, 0.525, 0]} />
      <Trophy position={[0.0,  0.525, 0]} />
      <Trophy position={[0.6,  0.525, 0]} />

      {/* Two trophies on middle shelf */}
      <Trophy position={[-0.4, 1.025, 0]} />
      <Trophy position={[0.4,  1.025, 0]} />

      {/* One trophy on top shelf */}
      <Trophy position={[0.0, 1.525, 0]} />

      {/* Wall backing */}
      <mesh position={[0, 1.05, -0.135]}>
        <boxGeometry args={[1.82, 1.65, 0.02]} />
        <meshStandardMaterial color='#1f2937' roughness={0.9} metalness={0.0} />
      </mesh>
    </group>
  );
}

export default TrophyWall;

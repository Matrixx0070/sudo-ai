import React from 'react';
import { ThreeElements } from '@react-three/fiber';

interface TableProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  round?: boolean;
  radius?: number;
  width?: number;
  depth?: number;
  color?: string;
}

export function Table({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  round = false,
  radius = 0.6,
  width = 1.2,
  depth = 0.8,
  color = '#374151',
}: TableProps) {
  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {round ? (
        <>
          {/* Round top */}
          <mesh position={[0, 0.7, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[radius, radius, 0.05, 32]} />
            <meshStandardMaterial color={color} roughness={0.6} metalness={0.1} />
          </mesh>

          {/* Single center leg */}
          <mesh position={[0, 0.35, 0]} castShadow>
            <cylinderGeometry args={[0.04, 0.04, 0.7, 12]} />
            <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
          </mesh>

          {/* Leg base spread */}
          <mesh position={[0, 0.02, 0]}>
            <cylinderGeometry args={[0.25, 0.25, 0.04, 12]} />
            <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
          </mesh>
        </>
      ) : (
        <>
          {/* Rectangular top */}
          <mesh position={[0, 0.7, 0]} castShadow receiveShadow>
            <boxGeometry args={[width, 0.05, depth]} />
            <meshStandardMaterial color={color} roughness={0.6} metalness={0.1} />
          </mesh>

          {/* Four legs */}
          {(
            [
              [-(width / 2 - 0.06), 0.35, -(depth / 2 - 0.06)],
              [ (width / 2 - 0.06), 0.35, -(depth / 2 - 0.06)],
              [-(width / 2 - 0.06), 0.35,  (depth / 2 - 0.06)],
              [ (width / 2 - 0.06), 0.35,  (depth / 2 - 0.06)],
            ] as [number, number, number][]
          ).map((pos, i) => (
            <mesh key={i} position={pos} castShadow>
              <cylinderGeometry args={[0.025, 0.025, 0.7, 8]} />
              <meshStandardMaterial color={color} roughness={0.5} metalness={0.3} />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}

export default Table;

import React from 'react';

interface RoomWallsProps {
  position?: [number, number, number];
  width: number;
  depth: number;
  wallHeight?: number;
  color?: string;
  /** Side to leave open for doorway: 'north' | 'south' | 'east' | 'west' | null */
  doorSide?: 'north' | 'south' | 'east' | 'west' | null;
}

export function RoomWalls({
  position = [0, 0, 0],
  width,
  depth,
  wallHeight = 0.8,
  color = '#1f2937',
  doorSide = null,
}: RoomWallsProps) {
  const wallThickness = 0.1;
  const wallY = wallHeight / 2; // center of the wall in Y

  const mat = <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />;

  return (
    <group position={position}>
      {/* North wall (negative Z edge) */}
      {doorSide !== 'north' && (
        <mesh position={[0, wallY, -(depth / 2)]} castShadow receiveShadow>
          <boxGeometry args={[width, wallHeight, wallThickness]} />
          {mat}
        </mesh>
      )}

      {/* South wall (positive Z edge) */}
      {doorSide !== 'south' && (
        <mesh position={[0, wallY, depth / 2]} castShadow receiveShadow>
          <boxGeometry args={[width, wallHeight, wallThickness]} />
          {mat}
        </mesh>
      )}

      {/* West wall (negative X edge) */}
      {doorSide !== 'west' && (
        <mesh position={[-(width / 2), wallY, 0]} castShadow receiveShadow>
          <boxGeometry args={[wallThickness, wallHeight, depth]} />
          {mat}
        </mesh>
      )}

      {/* East wall (positive X edge) */}
      {doorSide !== 'east' && (
        <mesh position={[width / 2, wallY, 0]} castShadow receiveShadow>
          <boxGeometry args={[wallThickness, wallHeight, depth]} />
          {mat}
        </mesh>
      )}
    </group>
  );
}

export default RoomWalls;

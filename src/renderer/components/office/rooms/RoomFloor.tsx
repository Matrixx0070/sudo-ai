import React from 'react';

interface RoomFloorProps {
  position?: [number, number, number];
  width: number;
  depth: number;
  color?: string;
}

export function RoomFloor({ position = [0, 0, 0], width, depth, color = '#111827' }: RoomFloorProps) {
  return (
    <mesh position={position} receiveShadow>
      <boxGeometry args={[width, 0.05, depth]} />
      <meshStandardMaterial color={color} roughness={0.8} metalness={0.1} />
    </mesh>
  );
}

export default RoomFloor;

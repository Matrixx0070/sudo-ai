import React from 'react';
import { ThreeElements } from '@react-three/fiber';

interface WhiteboardProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
}

export function Whiteboard({ position = [0, 0, 0], rotation = [0, 0, 0] }: WhiteboardProps) {
  const frameColor = '#374151';

  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Board surface */}
      <mesh position={[0, 1.5, 0]} castShadow>
        <boxGeometry args={[2, 1.2, 0.05]} />
        <meshStandardMaterial color='#f9fafb' roughness={0.95} metalness={0.0} />
      </mesh>

      {/* Top frame */}
      <mesh position={[0, 2.115, 0]}>
        <boxGeometry args={[2.06, 0.07, 0.06]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.4} />
      </mesh>

      {/* Bottom frame */}
      <mesh position={[0, 0.885, 0]}>
        <boxGeometry args={[2.06, 0.07, 0.06]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.4} />
      </mesh>

      {/* Left frame */}
      <mesh position={[-1.03, 1.5, 0]}>
        <boxGeometry args={[0.06, 1.34, 0.06]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.4} />
      </mesh>

      {/* Right frame */}
      <mesh position={[1.03, 1.5, 0]}>
        <boxGeometry args={[0.06, 1.34, 0.06]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.4} />
      </mesh>

      {/* Tray for markers at bottom */}
      <mesh position={[0, 0.85, 0.04]}>
        <boxGeometry args={[2.0, 0.06, 0.1]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.4} />
      </mesh>
    </group>
  );
}

export default Whiteboard;

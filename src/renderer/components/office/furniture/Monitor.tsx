import React, { useRef } from 'react';
import { useFrame, ThreeElements } from '@react-three/fiber';
import * as THREE from 'three';

interface MonitorProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
  active?: boolean;
}

export function Monitor({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  color = '#06b6d4',
  active = false,
}: MonitorProps) {
  const screenRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (!active || !materialRef.current) return;
    // Gentle pulse: emissive intensity oscillates between 0.4 and 1.2
    const t = clock.getElapsedTime();
    materialRef.current.emissiveIntensity = 0.4 + Math.sin(t * 1.5) * 0.4;
  });

  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Screen panel */}
      <mesh ref={screenRef} position={[0, 1.05, 0]} castShadow>
        <boxGeometry args={[0.5, 0.35, 0.02]} />
        {active ? (
          <meshStandardMaterial
            ref={materialRef}
            color={color}
            emissive={color}
            emissiveIntensity={0.8}
            roughness={0.2}
            metalness={0.6}
          />
        ) : (
          <meshStandardMaterial color='#374151' roughness={0.4} metalness={0.4} />
        )}
      </mesh>

      {/* Monitor stand neck */}
      <mesh position={[0, 0.82, 0]}>
        <boxGeometry args={[0.04, 0.25, 0.04]} />
        <meshStandardMaterial color='#374151' roughness={0.4} metalness={0.5} />
      </mesh>

      {/* Stand base */}
      <mesh position={[0, 0.72, 0.08]}>
        <boxGeometry args={[0.2, 0.02, 0.18]} />
        <meshStandardMaterial color='#374151' roughness={0.4} metalness={0.5} />
      </mesh>
    </group>
  );
}

export default Monitor;

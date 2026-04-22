import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface CoffeeMachineProps {
  position?: [number, number, number];
}

export function CoffeeMachine({ position = [0, 0, 0] }: CoffeeMachineProps) {
  const ledRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (!ledRef.current) return;
    const t = clock.getElapsedTime();
    // Slow, steady pulse — coffee machine is always "on"
    ledRef.current.emissiveIntensity = 0.6 + Math.sin(t * 1.2) * 0.4;
  });

  return (
    <group position={position}>
      {/* Main body */}
      <mesh position={[0, 0.2, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.3, 0.4, 0.25]} />
        <meshStandardMaterial color='#1f2937' roughness={0.4} metalness={0.5} />
      </mesh>

      {/* Water reservoir top */}
      <mesh position={[0.07, 0.45, 0]}>
        <boxGeometry args={[0.12, 0.12, 0.2]} />
        <meshStandardMaterial color='#374151' roughness={0.3} metalness={0.4} />
      </mesh>

      {/* Coffee funnel/pot holder — small cylinder */}
      <mesh position={[-0.05, 0.42, 0]}>
        <cylinderGeometry args={[0.05, 0.06, 0.08, 10]} />
        <meshStandardMaterial color='#374151' roughness={0.3} metalness={0.6} />
      </mesh>

      {/* Drip tray at base */}
      <mesh position={[0, 0.03, 0.04]}>
        <boxGeometry args={[0.24, 0.04, 0.18]} />
        <meshStandardMaterial color='#4b5563' roughness={0.5} metalness={0.5} />
      </mesh>

      {/* Red LED dot on front */}
      <mesh position={[0.1, 0.25, 0.128]}>
        <sphereGeometry args={[0.018, 8, 8]} />
        <meshStandardMaterial
          ref={ledRef}
          color='#ef4444'
          emissive='#ef4444'
          emissiveIntensity={1.0}
          roughness={0.1}
          metalness={0.1}
        />
      </mesh>
    </group>
  );
}

export default CoffeeMachine;

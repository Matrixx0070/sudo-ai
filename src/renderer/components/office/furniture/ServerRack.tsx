import React, { useRef } from 'react';
import { useFrame, ThreeElements } from '@react-three/fiber';
import * as THREE from 'three';

interface LedState {
  color: string;
  blinkOffset: number;
  blinkSpeed: number;
}

// Fixed LED config — 6 LEDs with pseudo-random but deterministic blink speeds
const LED_CONFIGS: LedState[] = [
  { color: '#22c55e', blinkOffset: 0.0,  blinkSpeed: 1.1 },
  { color: '#22c55e', blinkOffset: 0.7,  blinkSpeed: 0.9 },
  { color: '#eab308', blinkOffset: 1.4,  blinkSpeed: 1.7 },
  { color: '#22c55e', blinkOffset: 2.1,  blinkSpeed: 1.3 },
  { color: '#ef4444', blinkOffset: 2.8,  blinkSpeed: 0.6 },
  { color: '#22c55e', blinkOffset: 3.5,  blinkSpeed: 2.0 },
];

interface LedProps {
  position: [number, number, number];
  config: LedState;
}

function Led({ position, config }: LedProps) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (!matRef.current) return;
    const t = clock.getElapsedTime() * config.blinkSpeed + config.blinkOffset;
    const on = Math.sin(t) > 0;
    matRef.current.emissiveIntensity = on ? 1.5 : 0.1;
  });

  return (
    <mesh position={position}>
      <sphereGeometry args={[0.02, 8, 8]} />
      <meshStandardMaterial
        ref={matRef}
        color={config.color}
        emissive={config.color}
        emissiveIntensity={1.0}
        roughness={0.2}
        metalness={0.1}
      />
    </mesh>
  );
}

interface ServerRackProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
}

export function ServerRack({ position = [0, 0, 0], rotation = [0, 0, 0] }: ServerRackProps) {
  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Main body */}
      <mesh position={[0, 0.9, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.6, 1.8, 0.4]} />
        <meshStandardMaterial color='#1f2937' roughness={0.3} metalness={0.7} />
      </mesh>

      {/* Front panel (slightly lighter) */}
      <mesh position={[0, 0.9, 0.201]}>
        <boxGeometry args={[0.58, 1.78, 0.005]} />
        <meshStandardMaterial color='#111827' roughness={0.2} metalness={0.8} />
      </mesh>

      {/* LED indicators — evenly spaced along front */}
      {LED_CONFIGS.map((cfg, i) => (
        <Led
          key={i}
          position={[0.2, 0.3 + i * 0.26, 0.205] as [number, number, number]}
          config={cfg}
        />
      ))}
    </group>
  );
}

export default ServerRack;

import React, { useRef } from 'react';
import { useFrame, ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { AgentRuntime, AgentDefinition } from '../types.js';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import { AgentCharacter } from './AgentCharacter.js';
import { AgentNameTag } from './AgentNameTag.js';
import { AgentStatusIndicator } from './AgentStatusIndicator.js';
import { useAgentAnimation } from './AgentAnimations.js';

interface AgentGroupProps {
  agent: AgentRuntime;
  definition: AgentDefinition;
}

export function AgentGroup({ agent, definition }: AgentGroupProps): React.ReactElement {
  const selectAgent = useOfficeStore((s) => s.selectAgent);

  // Outer group for world position (lerped)
  const positionGroupRef = useRef<THREE.Group>(null);

  // Inner group for animations
  const { ref: animRef } = useAgentAnimation(agent.state);

  // Track current lerped position
  const currentPosRef = useRef<THREE.Vector3>(
    new THREE.Vector3(...agent.position)
  );

  useFrame((_, delta) => {
    if (!positionGroupRef.current) return;

    const target = new THREE.Vector3(...agent.targetPosition);
    currentPosRef.current.lerp(target, Math.min(1, delta * 3));

    positionGroupRef.current.position.copy(currentPosRef.current);
  });

  function handleClick(e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation();
    selectAgent(agent.code);
  }

  return (
    <group ref={positionGroupRef}>
      {/* Animation wrapper */}
      <group ref={animRef} onClick={handleClick}>
        <AgentCharacter color={definition.color} state={agent.state} />
        <AgentStatusIndicator state={agent.state} color={definition.color} />
        <AgentNameTag
          name={definition.name}
          role={definition.role}
          color={definition.color}
        />
      </group>
    </group>
  );
}

export default AgentGroup;

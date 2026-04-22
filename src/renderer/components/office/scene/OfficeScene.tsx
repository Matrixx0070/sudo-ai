import React from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import { AGENTS } from '../constants.js';
import { OwnerOffice } from '../rooms/OwnerOffice.js';
import { MainWorkspace } from '../rooms/MainWorkspace.js';
import { ServerRoom } from '../rooms/ServerRoom.js';
import { MeetingRoom } from '../rooms/MeetingRoom.js';
import { BreakRoom } from '../rooms/BreakRoom.js';
import { Lobby } from '../rooms/Lobby.js';
import { AgentGroup } from '../agents/AgentGroup.js';
import CameraController from './CameraController.js';
// PostProcessing disabled — causes React Error #300 in production builds
// import PostProcessing from './PostProcessing.js';

/**
 * OfficeScene — root 3D scene rendered inside a react-three-fiber <Canvas>.
 *
 * Responsibilities:
 *   - Lighting (ambient + two directional lights for soft shadows)
 *   - Atmospheric fog for depth cues
 *   - Ground plane that receives shadows
 *   - All six room components (OwnerOffice, MainWorkspace, ServerRoom,
 *     MeetingRoom, BreakRoom, Lobby)
 *   - All agent meshes read from officeStore
 *   - Headless CameraController and PostProcessing components
 */
export default function OfficeScene(): React.ReactElement {
  const agents = useOfficeStore((s) => s.agents);

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Lighting                                                            */}
      {/* ------------------------------------------------------------------ */}

      {/* Soft fill light — illuminates shadow areas uniformly */}
      <ambientLight intensity={0.4} />

      {/* Primary sun-like directional light from upper right front */}
      <directionalLight
        position={[10, 20, 10]}
        intensity={0.8}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />

      {/* Secondary fill light from opposite angle to soften harsh shadows */}
      <directionalLight position={[-10, 15, -10]} intensity={0.3} />

      {/* ------------------------------------------------------------------ */}
      {/* Atmosphere                                                          */}
      {/* ------------------------------------------------------------------ */}

      {/*
        Fog adds a sense of depth: objects within ~30 units are fully visible;
        beyond ~60 units they fade into the dark background colour.
      */}
      <fog attach="fog" args={['#0a0e1a', 30, 60]} />

      {/* ------------------------------------------------------------------ */}
      {/* Ground plane                                                        */}
      {/* ------------------------------------------------------------------ */}

      {/*
        A single large plane covers the full office footprint.
        Rotated -90° around X so it lies flat on Y = 0.
        Pushed 0.05 units below Y = 0 so room floors sit cleanly on top.
      */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.05, 5]}
        receiveShadow
      >
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0a0e1a" />
      </mesh>

      {/* ------------------------------------------------------------------ */}
      {/* Rooms                                                               */}
      {/* ------------------------------------------------------------------ */}

      <OwnerOffice />
      <MainWorkspace />
      <ServerRoom />
      <MeetingRoom />
      <BreakRoom />
      <Lobby />

      {/* ------------------------------------------------------------------ */}
      {/* Agents                                                              */}
      {/* ------------------------------------------------------------------ */}

      {Object.values(agents).map((agent) => {
        const def = AGENTS.find((a) => a.code === agent.code);
        if (!def) return null;
        return <AgentGroup key={agent.code} agent={agent} definition={def} />;
      })}

      {/* ------------------------------------------------------------------ */}
      {/* Headless scene controllers                                          */}
      {/* ------------------------------------------------------------------ */}

      {/* Drives smooth camera transitions based on officeStore state */}
      <CameraController />

      {/* Applies Bloom + Vignette post-processing passes */}
      {/* <PostProcessing /> — disabled for production compatibility */}
    </>
  );
}

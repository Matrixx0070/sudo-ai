import React, { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useOfficeStore } from '@renderer/stores/officeStore';
import { ROOMS, OVERVIEW_CAMERA_POSITION, OVERVIEW_CAMERA_TARGET } from '../constants';

/**
 * CameraController — headless component that drives smooth camera movement.
 *
 * Three camera modes, driven by officeStore:
 *   overview  — birds-eye view of the whole office floor
 *   room      — zooms to the selected room's defined camera position/target
 *   follow    — tracks the selected agent, offset above and behind
 *
 * All transitions use linear interpolation (lerp factor 0.05) every frame so
 * movement is always smooth regardless of how fast the store updates.
 */
export default function CameraController(): null {
  const { camera } = useThree();

  // Persist the look-at target across frames so it lerps independently of
  // the camera position lerp.
  const lookAtTarget = useRef(new THREE.Vector3(...OVERVIEW_CAMERA_TARGET));

  // Reusable vectors allocated once — avoids per-frame GC pressure.
  const targetPos = useRef(new THREE.Vector3(...OVERVIEW_CAMERA_POSITION));
  const targetLookAt = useRef(new THREE.Vector3(...OVERVIEW_CAMERA_TARGET));

  useFrame(() => {
    // Read the latest store snapshot inside useFrame for minimal re-render cost.
    const { cameraMode, selectedRoom, selectedAgent, agents } =
      useOfficeStore.getState();

    // --- Determine target position and look-at for this frame ---------------

    if (cameraMode === 'room' && selectedRoom !== null) {
      const room = ROOMS.find((r) => r.id === selectedRoom);
      if (room) {
        targetPos.current.set(...room.cameraPosition);
        targetLookAt.current.set(...room.cameraTarget);
      }
    } else if (cameraMode === 'follow' && selectedAgent !== null) {
      const agent = agents[selectedAgent];
      if (agent) {
        const [ax, ay, az] = agent.position;
        // Offset camera above and slightly behind the agent.
        targetPos.current.set(ax, ay + 5, az + 5);
        targetLookAt.current.set(ax, ay, az);
      }
    } else {
      // Default: overview
      targetPos.current.set(...OVERVIEW_CAMERA_POSITION);
      targetLookAt.current.set(...OVERVIEW_CAMERA_TARGET);
    }

    // --- Smoothly interpolate camera toward targets -------------------------

    const LERP_FACTOR = 0.05;
    camera.position.lerp(targetPos.current, LERP_FACTOR);
    lookAtTarget.current.lerp(targetLookAt.current, LERP_FACTOR);
    camera.lookAt(lookAtTarget.current);
  });

  return null;
}

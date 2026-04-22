import React from 'react';
import { RoomFloor } from './RoomFloor';
import { RoomWalls } from './RoomWalls';
import { RoomLabel } from './RoomLabel';
import { Desk } from '../furniture/Desk';
import { Chair } from '../furniture/Chair';
import { Monitor } from '../furniture/Monitor';
import { TrophyWall } from '../furniture/TrophyWall';

const ROOM_WIDTH = 10;
const ROOM_DEPTH = 8;

export function OwnerOffice() {
  return (
    <group position={[-6, 0, -5]}>
      <RoomFloor width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#0f172a' />
      <RoomWalls width={ROOM_WIDTH} depth={ROOM_DEPTH} doorSide='south' />

      {/* CEO desk — large, centered in room */}
      <Desk position={[0, 0, 0]} color='#1e3a5f' />

      {/* CEO chair behind desk */}
      <Chair position={[0, 0, 0.9]} color='#1e293b' />

      {/* Three monitors on the desk */}
      <Monitor position={[-0.5, 0, -0.2]} active color='#3b82f6' />
      <Monitor position={[0,   0, -0.2]} active color='#06b6d4' />
      <Monitor position={[0.5, 0, -0.2]} active color='#8b5cf6' />

      {/* Trophy wall on far left */}
      <TrophyWall position={[-4, 0, -3.5]} />

      {/* Floating room label */}
      <RoomLabel position={[0, 2, 0]} text="Owner's Office" />
    </group>
  );
}

export default OwnerOffice;

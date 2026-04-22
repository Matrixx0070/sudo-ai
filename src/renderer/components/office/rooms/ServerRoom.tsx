import React from 'react';
import { RoomFloor } from './RoomFloor';
import { RoomWalls } from './RoomWalls';
import { RoomLabel } from './RoomLabel';
import { ServerRack } from '../furniture/ServerRack';
import { Desk } from '../furniture/Desk';
import { Chair } from '../furniture/Chair';

const ROOM_WIDTH = 10;
const ROOM_DEPTH = 8;

export function ServerRoom() {
  return (
    <group position={[6, 0, 5]}>
      {/* Slightly blue-tinted floor for tech feel */}
      <RoomFloor width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#0a1628' />
      <RoomWalls width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#0f1f3d' doorSide='west' />

      {/* 4 server racks in a row along back wall */}
      <ServerRack position={[-3.5, 0, -3]} />
      <ServerRack position={[-1.5, 0, -3]} />
      <ServerRack position={[ 0.5, 0, -3]} />
      <ServerRack position={[ 2.5, 0, -3]} />

      {/* 2 operator desks */}
      <Desk position={[-2.5, 0, 1.5]} color='#1e293b' />
      <Chair position={[-2.5, 0, 2.4]} color='#1e293b' />

      <Desk position={[1.5, 0, 1.5]} color='#1e293b' />
      <Chair position={[1.5, 0, 2.4]} color='#1e293b' />

      <RoomLabel position={[0, 2, 0]} text='Server Room' />
    </group>
  );
}

export default ServerRoom;

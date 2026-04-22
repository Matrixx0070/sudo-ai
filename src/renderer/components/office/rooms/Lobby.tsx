import React from 'react';
import { RoomFloor } from './RoomFloor';
import { RoomWalls } from './RoomWalls';
import { RoomLabel } from './RoomLabel';
import { Desk } from '../furniture/Desk';
import { Chair } from '../furniture/Chair';
import { TaskBoard } from '../furniture/TaskBoard';
import { Sofa } from '../furniture/Sofa';

const ROOM_WIDTH = 10;
const ROOM_DEPTH = 8;

export function Lobby() {
  return (
    <group position={[6, 0, 15]}>
      {/* Brighter, welcoming floor */}
      <RoomFloor width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#1e293b' />
      <RoomWalls width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#334155' doorSide='west' />

      {/* Reception desk — near the entrance */}
      <Desk position={[0, 0, 1.5]} color='#1e3a5f' />
      <Chair position={[0, 0, 2.4]} color='#1e293b' />

      {/* Task board on north wall */}
      <TaskBoard position={[0, 0, -3.45]} rotation={[0, 0, 0]} />

      {/* Waiting area sofa on the right */}
      <Sofa position={[3, 0, -1]} rotation={[0, -Math.PI / 2, 0]} color='#1e293b' />

      {/* Additional waiting chairs on the left */}
      <Chair position={[-3.0, 0, -1.5]} color='#1e293b' />
      <Chair position={[-2.0, 0, -1.5]} color='#1e293b' />

      <RoomLabel position={[0, 2, 0]} text='Lobby' />
    </group>
  );
}

export default Lobby;

import React from 'react';
import { RoomFloor } from './RoomFloor';
import { RoomWalls } from './RoomWalls';
import { RoomLabel } from './RoomLabel';
import { Desk } from '../furniture/Desk';
import { Chair } from '../furniture/Chair';
import { Monitor } from '../furniture/Monitor';

const ROOM_WIDTH = 12;
const ROOM_DEPTH = 10;

// 6 desks in 2 rows of 3
const DESK_POSITIONS: [number, number, number][] = [
  [-3.5, 0, -2.5],
  [ 0.0, 0, -2.5],
  [ 3.5, 0, -2.5],
  [-3.5, 0,  2.0],
  [ 0.0, 0,  2.0],
  [ 3.5, 0,  2.0],
];

export function MainWorkspace() {
  return (
    <group position={[-6, 0, 5]}>
      <RoomFloor width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#111827' />
      <RoomWalls width={ROOM_WIDTH} depth={ROOM_DEPTH} doorSide='north' />

      {DESK_POSITIONS.map((pos, i) => {
        // Front row faces south (no rotation), back row faces north (rotate 180)
        const rotation: [number, number, number] = i >= 3 ? [0, Math.PI, 0] : [0, 0, 0];
        const chairZ = i >= 3 ? pos[2] + 0.9 : pos[2] + 0.9;
        return (
          <group key={i}>
            <Desk position={pos} rotation={rotation} />
            <Chair
              position={[pos[0], 0, chairZ]}
              rotation={rotation}
            />
            <Monitor
              position={[pos[0], 0, pos[2] - 0.2 * (i >= 3 ? -1 : 1)]}
              active
              color='#06b6d4'
            />
          </group>
        );
      })}

      <RoomLabel position={[0, 2, 0]} text='Main Workspace' />
    </group>
  );
}

export default MainWorkspace;

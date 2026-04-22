import React from 'react';
import { RoomFloor } from './RoomFloor';
import { RoomWalls } from './RoomWalls';
import { RoomLabel } from './RoomLabel';
import { Table } from '../furniture/Table';
import { Chair } from '../furniture/Chair';
import { Whiteboard } from '../furniture/Whiteboard';

const ROOM_WIDTH = 10;
const ROOM_DEPTH = 8;

// 6 chairs evenly around a round table (radius 1.2)
const CHAIR_ANGLES = [0, 60, 120, 180, 240, 300]; // degrees

export function MeetingRoom() {
  const tableRadius = 1.2;

  return (
    <group position={[6, 0, -5]}>
      <RoomFloor width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#111827' />
      <RoomWalls width={ROOM_WIDTH} depth={ROOM_DEPTH} doorSide='west' />

      {/* Central round table */}
      <Table position={[0, 0, 0]} round radius={tableRadius} color='#374151' />

      {/* 6 chairs evenly around the table */}
      {CHAIR_ANGLES.map((angleDeg, i) => {
        const rad = (angleDeg * Math.PI) / 180;
        const dist = tableRadius + 0.45; // seat pulled back from table edge
        const x = Math.sin(rad) * dist;
        const z = -Math.cos(rad) * dist;
        const rotY = rad; // chair faces center
        return (
          <Chair
            key={i}
            position={[x, 0, z]}
            rotation={[0, rotY, 0]}
            color='#1f2937'
          />
        );
      })}

      {/* Whiteboard on north wall — flat against wall */}
      <Whiteboard position={[0, 0, -3.6]} rotation={[0, 0, 0]} />

      <RoomLabel position={[0, 2, 0]} text='Meeting Room' />
    </group>
  );
}

export default MeetingRoom;

import React from 'react';
import { RoomFloor } from './RoomFloor';
import { RoomWalls } from './RoomWalls';
import { RoomLabel } from './RoomLabel';
import { Sofa } from '../furniture/Sofa';
import { CoffeeMachine } from '../furniture/CoffeeMachine';
import { Table } from '../furniture/Table';
import { Chair } from '../furniture/Chair';

const ROOM_WIDTH = 10;
const ROOM_DEPTH = 8;

export function BreakRoom() {
  return (
    <group position={[-6, 0, 15]}>
      {/* Warm, inviting floor tone */}
      <RoomFloor width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#1a1208' />
      <RoomWalls width={ROOM_WIDTH} depth={ROOM_DEPTH} color='#2d1f0e' doorSide='east' />

      {/* Sofa along the back wall */}
      <Sofa position={[0, 0, -2.5]} color='#6b4c2a' />

      {/* Small coffee table in front of sofa */}
      <Table position={[0, 0, -1.2]} round={false} width={0.8} depth={0.5} color='#4a3520' />

      {/* Counter along the left wall with coffee machine */}
      <mesh position={[-3.8, 0.45, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.0, 0.9, 0.5]} />
        <meshStandardMaterial color='#374151' roughness={0.6} metalness={0.2} />
      </mesh>
      <CoffeeMachine position={[-3.5, 0.9, 0]} />

      {/* Small round table for breaks */}
      <Table position={[2.5, 0, 1.5]} round radius={0.5} color='#4a3520' />
      <Chair position={[2.5, 0, 2.1]} color='#6b4c2a' />
      <Chair position={[2.5, 0, 0.9]} rotation={[0, Math.PI, 0]} color='#6b4c2a' />

      <RoomLabel position={[0, 2, 0]} text='Break Room' />
    </group>
  );
}

export default BreakRoom;

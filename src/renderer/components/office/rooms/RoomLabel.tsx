import React from 'react';
import { Html, Billboard } from '@react-three/drei';

interface RoomLabelProps {
  position?: [number, number, number];
  text: string;
}

export function RoomLabel({ position = [0, 2, 0], text }: RoomLabelProps) {
  return (
    <Billboard position={position}>
      <Html center>
        <div
          style={{
            color: '#ffffff',
            fontSize: '14px',
            fontWeight: 'bold',
            whiteSpace: 'nowrap',
            textShadow: '0 0 6px #000, 0 0 12px #000',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {text}
        </div>
      </Html>
    </Billboard>
  );
}

export default RoomLabel;

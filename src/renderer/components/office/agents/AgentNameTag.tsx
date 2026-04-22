import React from 'react';
import { Html } from '@react-three/drei';

interface AgentNameTagProps {
  name: string;
  role: string;
  color: string;
}

export function AgentNameTag({ name, role, color }: AgentNameTagProps): React.ReactElement {
  return (
    <group position={[0, 1.8, 0]}>
      <Html center>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {/* Agent name — bold, larger */}
          <div
            style={{
              color: color,
              fontSize: '13px',
              fontWeight: 'bold',
              whiteSpace: 'nowrap',
              textShadow: '0 0 4px #000, 0 0 8px #000',
              lineHeight: 1.2,
            }}
          >
            {name}
          </div>
          {/* Agent role — smaller, lighter */}
          <div
            style={{
              color: '#cccccc',
              fontSize: '10px',
              whiteSpace: 'nowrap',
              textShadow: '0 0 4px #000, 0 0 8px #000',
              lineHeight: 1.2,
            }}
          >
            {role}
          </div>
        </div>
      </Html>
    </group>
  );
}

export default AgentNameTag;

import React from 'react';
import type { RoomLayout } from './types.js';

interface RoomProps {
  layout: RoomLayout;
}

/**
 * Room
 *
 * Renders a single office room as an absolutely positioned HTML element
 * within the scene coordinate space. All asset images are placed using
 * percentage coordinates relative to the room container.
 *
 * - pointer-events: none — click zones are handled by RoomZone, not here
 * - Images use loading="lazy" to avoid blocking the initial paint
 * - The room name label is visible at bottom-center for debugging / overview
 */
export function Room({ layout }: RoomProps): React.ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${layout.left}%`,
        top: `${layout.top}%`,
        width: `${layout.width}%`,
        height: `${layout.height}%`,
        pointerEvents: 'none',
      }}
      role="img"
      aria-label={layout.name}
      data-room-id={layout.id}
    >
      {/* Inner container keeps assets contained and stacked correctly */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        {layout.assets.map((asset, index) => (
          <img
            key={asset.label ?? `${layout.id}-asset-${index}`}
            src={asset.src}
            alt={asset.label ?? ''}
            draggable={false}
            loading="lazy"
            style={{
              position: 'absolute',
              left: `${asset.left}%`,
              top: `${asset.top}%`,
              width: `${asset.width}%`,
              height: 'auto',
              zIndex: asset.z,
              filter: asset.filter ?? undefined,
              display: 'block',
            }}
          />
        ))}

        {/* Room label — shown at bottom-center, semi-transparent */}
        <span
          style={{
            position: 'absolute',
            bottom: '4px',
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: '10px',
            fontFamily: 'system-ui, sans-serif',
            color: 'rgba(255, 255, 255, 0.45)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            userSelect: 'none',
            zIndex: 100,
          }}
          aria-hidden="true"
        >
          {layout.name}
        </span>
      </div>
    </div>
  );
}

export default Room;

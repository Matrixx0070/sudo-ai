/**
 * RoomZone
 *
 * An invisible, absolutely-positioned click area overlaid on a room in
 * the Crystal Palace background image. Clicking triggers a CSS zoom that
 * centres the view on that room. Shows a label on hover.
 */

import React from 'react';
import type { RoomId } from './types.js';
import './crystal-office.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomZoneDefinition {
  id: RoomId;
  name: string;
  /** % from left edge of office container */
  x: number;
  /** % from top edge of office container */
  y: number;
  /** % width */
  width: number;
  /** % height */
  height: number;
  /**
   * CSS translate offsets to apply when zoomed into this room.
   * These shift the scene so the room appears centred after scale(2.5).
   * Formula: zoomX = (50 - centrePctX) / 2.5, zoomY = (50 - centrePctY) / 2.5
   */
  zoomX: string;
  zoomY: string;
}

interface RoomZoneProps {
  room: RoomZoneDefinition;
  isActive: boolean;
  onZoom: (room: RoomZoneDefinition) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoomZone({ room, isActive, onZoom }: RoomZoneProps): React.ReactElement {
  function handleClick(): void {
    onZoom(room);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onZoom(room);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Zoom into ${room.name}`}
      aria-pressed={isActive}
      className={`room-zone${isActive ? ' active' : ''}`}
      style={{
        left: `${room.x}%`,
        top: `${room.y}%`,
        width: `${room.width}%`,
        height: `${room.height}%`,
        zIndex: 5,
      }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className="room-zone__label">{room.name}</span>
    </div>
  );
}

export default RoomZone;

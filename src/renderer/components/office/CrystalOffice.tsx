/**
 * CrystalOffice
 *
 * Lightweight office view using the pre-rendered background image.
 * - Background: office-bg.jpg (359 KB) — the Crystal Palace reference image
 * - Agents: absolutely-positioned sprite images with CSS animation
 * - Rooms: invisible click-zones that trigger CSS-transform zoom
 * - Particles: 40 CSS-keyframe floating dots for atmosphere
 * - HUD: all existing components (EventFeed, MetricsBar, etc.) reused verbatim
 *
 * Room and GlassWall components are NOT rendered — the background image
 * already contains all furniture, floors, and walls. This removes ~45 MB of
 * individual PNGs from the render path.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import { AGENTS } from './constants.js';
import { AgentSprite } from './AgentSprite.js';
import { RoomZone } from './RoomZone.js';
import type { RoomZoneDefinition } from './RoomZone.js';
import { ParticleOverlay } from './ParticleOverlay.js';
import { AssetPreloader } from './AssetPreloader.js';
import type { RoomId } from './types.js';
import './crystal-office.css';

// ---------------------------------------------------------------------------
// Agent 2-D positions (% of container width/height)
// Calibrated for office-bg.jpg background image.
//
// ROOM_DESK_POSITIONS maps each room to ordered desk slots so that when the
// drama engine calls moveAgentToRoom the sprite smoothly transitions to the
// correct screen location.
// ---------------------------------------------------------------------------

interface AgentPosition {
  x: number;  // % from left
  y: number;  // % from top
}

/** Per-room desk positions as screen-space percentages — calibrated for office-bg.jpg */
const ROOM_DESK_POSITIONS: Record<RoomId, AgentPosition[]> = {
  workspace: [
    { x: 34, y: 52 },
    { x: 42, y: 50 },
    { x: 50, y: 52 },
    { x: 58, y: 50 },
    { x: 38, y: 61 },
    { x: 46, y: 63 },
  ],
  'server-room':  [{ x: 76, y: 46 }, { x: 84, y: 44 }],
  'meeting-room': [{ x: 28, y: 35 }, { x: 32, y: 33 }, { x: 36, y: 35 }],
  'frank-office': [{ x: 13, y: 28 }],
  'break-room':   [{ x: 12, y: 72 }],
  lobby:          [{ x: 72, y: 78 }],
};

/**
 * Return the screen-space (x%, y%) for an agent based on their current room
 * and defaultDesk index. Falls back to room slot 0 if desk index is out of
 * range, and then to the centre of the screen as a last resort.
 */
function resolvePosition(currentRoom: RoomId, deskIndex: number): AgentPosition {
  const slots = ROOM_DESK_POSITIONS[currentRoom];
  if (!slots || slots.length === 0) return { x: 50, y: 50 };
  return slots[deskIndex] ?? slots[0];
}

// ---------------------------------------------------------------------------
// Room zone definitions — calibrated for office-bg.jpg background image.
// zoomX / zoomY pan the CSS-transform zoom to centre the chosen room.
// ---------------------------------------------------------------------------

const ROOM_ZONES: RoomZoneDefinition[] = [
  { id: 'frank-office',  name: 'CEO Office',      x: 5,  y: 5,  width: 22, height: 32, zoomX: '9%',   zoomY: '11.6%' },
  { id: 'workspace',     name: 'Main Workspace',  x: 25, y: 35, width: 42, height: 38, zoomX: '-6%',  zoomY: '-4%'   },
  { id: 'meeting-room',  name: 'Meeting Room',    x: 56, y: 5,  width: 22, height: 28, zoomX: '-14%', zoomY: '11.6%' },
  { id: 'server-room',   name: 'Server Room',     x: 71, y: 32, width: 24, height: 34, zoomX: '-18%', zoomY: '-2.4%' },
  { id: 'break-room',    name: 'Break Room',      x: 5,  y: 60, width: 22, height: 34, zoomX: '9%',   zoomY: '-8%'   },
  { id: 'lobby',         name: 'Lobby',           x: 62, y: 64, width: 30, height: 30, zoomX: '-15%', zoomY: '-10%'  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CrystalOffice(): React.ReactElement {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [zoomedRoomId, setZoomedRoomId] = useState<string | null>(null);

  // Read agent runtime states from store so positions update reactively
  const agentRuntimes = useOfficeStore((s) => s.agents);

  // -------------------------------------------------------------------------
  // Zoom into a room
  // -------------------------------------------------------------------------

  const zoomIntoRoom = useCallback((room: RoomZoneDefinition): void => {
    if (!sceneRef.current) return;

    if (zoomedRoomId === room.id) {
      // Second click on same room → zoom out
      handleZoomOut();
      return;
    }

    sceneRef.current.style.setProperty('--zoom-x', room.zoomX);
    sceneRef.current.style.setProperty('--zoom-y', room.zoomY);
    sceneRef.current.classList.add('zoomed');
    setZoomedRoomId(room.id);
  }, [zoomedRoomId]);

  const handleZoomOut = useCallback((): void => {
    if (!sceneRef.current) return;
    sceneRef.current.classList.remove('zoomed');
    setZoomedRoomId(null);
  }, []);

  // -------------------------------------------------------------------------
  // ESC key zooms out
  // -------------------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && zoomedRoomId !== null) {
        handleZoomOut();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomedRoomId, handleZoomOut]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      className="crystal-office"
      role="region"
      aria-label="Crystal Palace Office"
    >
      {/* Scene wrapper — this element gets the CSS zoom transform */}
      <div ref={sceneRef} className="crystal-office__scene">
        {/* Asset preloader — warms browser cache for character sprites */}
        <AssetPreloader />

        {/* Background image — the Crystal Palace office reference (359 KB).
            This replaces the 65 individual room PNG assets (~27 MB). */}
        <img
          src="/office-bg.jpg"
          alt=""
          aria-hidden="true"
          className="crystal-office__bg"
          draggable={false}
        />

        {/* Particle layer (z-index: 15 in CSS) */}
        <ParticleOverlay />

        {/* Room click zones (z-index: 25) */}
        {ROOM_ZONES.map((room) => (
          <RoomZone
            key={room.id}
            room={room}
            isActive={zoomedRoomId === room.id}
            onZoom={zoomIntoRoom}
          />
        ))}

        {/* Agent sprites disabled — background image already contains painted agents.
            Enabling these would double-up characters on screen. */}
      </div>

      {/* Zoom-out button (outside scene — doesn't scale with it) */}
      {zoomedRoomId !== null && (
        <button
          type="button"
          className="crystal-zoom-out"
          onClick={handleZoomOut}
          aria-label="Zoom out to full office view"
        >
          &#8598; Zoom Out
        </button>
      )}
    </div>
  );
}

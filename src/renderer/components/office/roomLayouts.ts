import type { RoomLayout } from './types.js';

// Asset path helper — category-aware, all images live under /office/{category}/
const P = (category: string, name: string) => `/office/${category}/${name}.png`;

// Shorthand asset builders
const frame  = ()                => ({ src: P('structure', 'room-frame'), left: 0,  top: 0,  width: 100, z: 2 });
const tile   = (n: number, l: number, t: number, w = 35) =>
                                    ({ src: P('floors', `floor-tile-${n}`),  left: l,  top: t,  width: w,   z: 1 });
const tile20 = (n: number, l: number, t: number) => tile(n, l, t, 20);
const tile25 = (n: number, l: number, t: number) => tile(n, l, t, 25);
const furn   = (cat: string, name: string, l: number, t: number, w: number, z: number, label?: string) =>
                                    ({ src: P(cat, name),                  left: l,  top: t,  width: w,   z, label });

export const ROOM_LAYOUTS: RoomLayout[] = [
  // ─────────────────────────────────────────────────────────
  // ROOM 1: CEO Office
  // ─────────────────────────────────────────────────────────
  {
    id:     'frank-office',
    name:   'CEO Office',
    left:   2.5,
    top:    2.8,
    width:  21.9,
    height: 38.9,
    zoomX:  '14.3%',
    zoomY:  '11.1%',
    assets: [
      frame(),
      // floor tiles
      tile(1, 15, 35),
      tile(2, 50, 35),
      tile(1, 15, 55),
      tile(2, 50, 55),
      // furniture
      furn('furniture',  'exec-desk',    30, 40, 40, 5, 'exec-desk'),
      furn('furniture',  'chair',        38, 55, 20, 6, 'chair'),
      furn('structure',  'trophy-shelf', 65, 25, 30, 4, 'trophy-shelf'),
      furn('decorative', 'crystal-large', 8, 15, 18, 6, 'crystal-large'),
      furn('decorative', 'floor-lamp',   75, 30, 12, 6, 'floor-lamp'),
    ],
  },

  // ─────────────────────────────────────────────────────────
  // ROOM 2: Main Workspace
  // ─────────────────────────────────────────────────────────
  {
    id:     'workspace',
    name:   'Main Workspace',
    left:   26.6,
    top:    5.6,
    width:  43.8,
    height: 44.4,
    zoomX:  '0.7%',
    zoomY:  '8.9%',
    assets: [
      frame(),
      // floor tiles (top row)
      tile20(3,  5, 30),
      tile20(4, 25, 30),
      tile20(5, 45, 30),
      // floor tiles (bottom row)
      tile20(6,  5, 55),
      tile20(7, 25, 55),
      tile20(8, 45, 55),
      // Desk 0 – Nova
      furn('furniture', 'work-desk', 10, 35, 18, 4, 'desk-0-nova'),
      furn('furniture', 'chair',     14, 48, 10, 5, 'chair-0-nova'),
      // Desk 1 – Kuro
      furn('furniture', 'work-desk', 30, 33, 18, 4, 'desk-1-kuro'),
      furn('furniture', 'chair',     34, 46, 10, 5, 'chair-1-kuro'),
      // Desk 2 – Pixel
      furn('furniture', 'work-desk', 50, 35, 18, 4, 'desk-2-pixel'),
      furn('furniture', 'chair',     54, 48, 10, 5, 'chair-2-pixel'),
      // Desk 3 – Echo
      furn('furniture', 'work-desk', 10, 58, 18, 5, 'desk-3-echo'),
      furn('furniture', 'chair',     14, 71, 10, 6, 'chair-3-echo'),
      // Desk 4 – Flux
      furn('furniture', 'work-desk', 30, 56, 18, 5, 'desk-4-flux'),
      furn('furniture', 'chair',     34, 69, 10, 6, 'chair-4-flux'),
      // Desk 5 – Vex
      furn('furniture', 'work-desk', 50, 58, 18, 5, 'desk-5-vex'),
      furn('furniture', 'chair',     54, 71, 10, 6, 'chair-5-vex'),
    ],
  },

  // ─────────────────────────────────────────────────────────
  // ROOM 3: Meeting Room
  // ─────────────────────────────────────────────────────────
  {
    id:     'meeting-room',
    name:   'Meeting Room',
    left:   73.4,
    top:    2.8,
    width:  23.4,
    height: 38.9,
    zoomX:  '-14.1%',
    zoomY:  '11.1%',
    assets: [
      frame(),
      // floor tiles
      tile(9,  15, 35),
      tile(10, 50, 35),
      tile(9,  15, 55),
      tile(10, 50, 55),
      // furniture
      furn('furniture', 'meeting-table', 25, 38, 45, 5, 'meeting-table'),
      // chairs around the table
      furn('furniture', 'chair', 15, 42, 12, 4, 'chair-left-top'),
      furn('furniture', 'chair', 15, 55, 12, 6, 'chair-left-bot'),
      furn('furniture', 'chair', 65, 42, 12, 4, 'chair-right-top'),
      furn('furniture', 'chair', 65, 55, 12, 6, 'chair-right-bot'),
      furn('furniture', 'chair', 35, 60, 12, 7, 'chair-bot-1'),
      furn('furniture', 'chair', 50, 60, 12, 7, 'chair-bot-2'),
      // decor
      furn('structure', 'whiteboard', 25, 12, 45, 3, 'whiteboard'),
    ],
  },

  // ─────────────────────────────────────────────────────────
  // ROOM 4: Server Room
  // ─────────────────────────────────────────────────────────
  {
    id:     'server-room',
    name:   'Server Room',
    left:   65.6,
    top:    47.2,
    width:  25.0,
    height: 41.7,
    zoomX:  '-11.2%',
    zoomY:  '-7.2%',
    assets: [
      frame(),
      // floor tiles
      tile(11, 15, 35),
      tile(12, 50, 35),
      tile(11, 15, 55),
      tile(12, 50, 55),
      // server racks
      furn('decorative', 'server-rack', 10, 25, 18, 4, 'rack-0'),
      furn('decorative', 'server-rack', 30, 23, 18, 4, 'rack-1'),
      furn('decorative', 'server-rack', 55, 25, 18, 4, 'rack-2'),
      furn('decorative', 'server-rack', 75, 23, 18, 4, 'rack-3'),
      // holo display
      furn('decorative', 'holo-display', 35, 50, 30, 6, 'holo-display'),
    ],
  },

  // ─────────────────────────────────────────────────────────
  // ROOM 5: Break Room
  // ─────────────────────────────────────────────────────────
  {
    id:     'break-room',
    name:   'Break Room',
    left:   2.5,
    top:    47.2,
    width:  21.9,
    height: 38.9,
    zoomX:  '14.3%',
    zoomY:  '-6.7%',
    assets: [
      frame(),
      // floor tiles
      tile(1, 15, 35),
      tile(3, 50, 35),
      tile(1, 15, 55),
      tile(3, 50, 55),
      // furniture
      furn('furniture',  'sofa',           15, 35, 35, 4, 'sofa'),
      furn('furniture',  'coffee-machine', 65, 28, 18, 4, 'coffee-machine'),
      furn('furniture',  'glass-table',    30, 52, 25, 5, 'glass-table'),
      furn('decorative', 'plant',          75, 50, 12, 6, 'plant'),
    ],
  },

  // ─────────────────────────────────────────────────────────
  // ROOM 6: Lobby
  // ─────────────────────────────────────────────────────────
  {
    id:     'lobby',
    name:   'Lobby',
    left:   26.6,
    top:    50.0,
    width:  31.3,
    height: 41.7,
    zoomX:  '3.2%',
    zoomY:  '-8.3%',
    assets: [
      frame(),
      // floor tiles (top row)
      tile25(5,  5, 35),
      tile25(7, 30, 35),
      tile25(9, 55, 35),
      // floor tiles (bottom row)
      tile25(5,  5, 55),
      tile25(7, 30, 55),
      tile25(9, 55, 55),
      // furniture
      furn('structure',  'reception-desk', 25, 35, 45, 5, 'reception-desk'),
      furn('structure',  'door-frame',     40, 10, 20, 3, 'door-frame'),
      furn('furniture',  'task-board',     70, 20, 18, 4, 'task-board'),
      furn('decorative', 'crystal-small',  10, 25,  8, 6, 'crystal-small'),
    ],
  },
];

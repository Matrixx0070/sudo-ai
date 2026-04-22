import type { AgentDefinition, RoomDefinition, RoomId } from './types.js';

export const AGENTS: AgentDefinition[] = [
  { code: 'SUDO-1', name: 'Nova',  role: 'Lead Coder',      gender: 'F', color: '#3b82f6', defaultRoom: 'workspace',    defaultDesk: 0 },
  { code: 'SUDO-2', name: 'Kuro',  role: 'Security',        gender: 'M', color: '#dc2626', defaultRoom: 'workspace',    defaultDesk: 1 },
  { code: 'SUDO-3', name: 'Pixel', role: 'Designer',        gender: 'F', color: '#a855f7', defaultRoom: 'workspace',    defaultDesk: 2 },
  { code: 'SUDO-4', name: 'Bolt',  role: 'DevOps',          gender: 'M', color: '#eab308', defaultRoom: 'server-room',  defaultDesk: 0 },
  { code: 'SUDO-5', name: 'Echo',  role: 'Researcher',      gender: 'F', color: '#14b8a6', defaultRoom: 'workspace',    defaultDesk: 3 },
  { code: 'SUDO-6', name: 'Flux',  role: 'Content Creator', gender: 'M', color: '#f97316', defaultRoom: 'workspace',    defaultDesk: 4 },
  { code: 'SUDO-7', name: 'Vex',   role: 'QA Tester',       gender: 'M', color: '#22c55e', defaultRoom: 'workspace',    defaultDesk: 5 },
  { code: 'SUDO-8', name: 'Aria',  role: 'Project Manager', gender: 'F', color: '#f59e0b', defaultRoom: 'meeting-room', defaultDesk: 0 },
];

export const ROOMS: RoomDefinition[] = [
  { id: 'frank-office',  name: "The Owner's Office",  position: [-6, 0, -5], size: [10, 8], cameraTarget: [-6, 0, -5], cameraPosition: [-6, 8, 2]  },
  { id: 'meeting-room',  name: 'Meeting Room',    position: [6,  0, -5], size: [10, 8], cameraTarget: [6,  0, -5], cameraPosition: [6,  8, 2]  },
  { id: 'workspace',     name: 'Main Workspace',  position: [-6, 0,  5], size: [10, 8], cameraTarget: [-6, 0,  5], cameraPosition: [-6, 8, 12] },
  { id: 'server-room',   name: 'Server Room',     position: [6,  0,  5], size: [10, 8], cameraTarget: [6,  0,  5], cameraPosition: [6,  8, 12] },
  { id: 'break-room',    name: 'Break Room',      position: [-6, 0, 15], size: [10, 8], cameraTarget: [-6, 0, 15], cameraPosition: [-6, 8, 22] },
  { id: 'lobby',         name: 'Lobby',           position: [6,  0, 15], size: [10, 8], cameraTarget: [6,  0, 15], cameraPosition: [6,  8, 22] },
];

export const DESK_POSITIONS: Record<RoomId, [number, number, number][]> = {
  workspace:      [[-9, 0, 3], [-7, 0, 3], [-5, 0, 3], [-3, 0, 3], [-9, 0, 7], [-7, 0, 7]],
  'server-room':  [[4,  0, 4], [8,  0, 4]],
  'meeting-room': [[6,  0, -5]],
  'frank-office': [[-6, 0, -5]],
  'break-room':   [[-7, 0, 14]],
  lobby:          [[8,  0, 14]],
};

/** Overview camera defaults */
export const OVERVIEW_CAMERA_POSITION: [number, number, number] = [0, 30, 20];
export const OVERVIEW_CAMERA_TARGET: [number, number, number] = [0, 0, 5];

/** Maximum events kept in store */
export const MAX_EVENTS = 50;

export type AgentCode = 'SUDO-1' | 'SUDO-2' | 'SUDO-3' | 'SUDO-4' | 'SUDO-5' | 'SUDO-6' | 'SUDO-7' | 'SUDO-8';
export type AgentState = 'idle' | 'working' | 'thinking' | 'talking' | 'walking' | 'break' | 'error';
export type Gender = 'M' | 'F';
export type RoomId = 'frank-office' | 'workspace' | 'server-room' | 'meeting-room' | 'break-room' | 'lobby';
export type CameraMode = 'overview' | 'room' | 'follow';
export type OfficeEventType =
  | 'agent-state-change'
  | 'task-assigned'
  | 'task-completed'
  | 'agent-moved'
  | 'agent-chat'
  | 'agent-error'
  | 'agent-break'
  | 'meeting-started'
  | 'meeting-ended'
  | 'system-alert';

export interface AgentDefinition {
  code: AgentCode;
  name: string;
  role: string;
  gender: Gender;
  color: string;
  defaultRoom: RoomId;
  defaultDesk: number;
}

export interface AgentRuntime {
  code: AgentCode;
  state: AgentState;
  currentRoom: RoomId;
  position: [number, number, number];
  targetPosition: [number, number, number];
  currentTask: string | null;
  taskProgress: number;
  lastActivity: string;
  lastActivityTime: number;
}

export interface RoomDefinition {
  id: RoomId;
  name: string;
  position: [number, number, number];
  size: [number, number];
  cameraTarget: [number, number, number];
  cameraPosition: [number, number, number];
}

export interface OfficeEvent {
  id: string;
  type: OfficeEventType;
  timestamp: number;
  agentCode: AgentCode | null;
  targetAgentCode: AgentCode | null;
  message: string;
  room: RoomId;
}

export interface OfficeTask {
  id: string;
  title: string;
  assignedTo: AgentCode | null;
  status: 'queued' | 'in-progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high';
}

export type PoseKey = 'sitting' | 'standing' | 'walk-right' | 'walk-left';

export interface RoomAssetPlacement {
  src: string;      // e.g. '/office/furniture/exec-desk.png'
  left: number;     // % from left of room container
  top: number;      // % from top of room container
  width: number;    // % width relative to room container
  z: number;        // z-index within room
  filter?: string;  // optional CSS filter
  label?: string;   // debugging label
}

export interface RoomLayout {
  id: RoomId;
  name: string;
  left: number;    // % position in scene
  top: number;
  width: number;
  height: number;
  zoomX: string;   // CSS translate for zoom
  zoomY: string;
  assets: RoomAssetPlacement[];
}

/** WebSocket message shape sent by the backend drama engine. */
export interface WSOfficeMessage {
  type: OfficeEventType;
  agentCode?: AgentCode;
  targetAgentCode?: AgentCode;
  message?: string;
  room?: RoomId;
  state?: AgentState;
  position?: [number, number, number];
  targetPosition?: [number, number, number];
  task?: string;
  taskProgress?: number;
  taskId?: string;
  taskTitle?: string;
  assignedTo?: AgentCode;
  taskStatus?: OfficeTask['status'];
  priority?: OfficeTask['priority'];
  cpu?: number;
  memory?: number;
  disk?: number;
  uptime?: number;
}

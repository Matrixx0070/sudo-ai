import { create } from 'zustand';
import type {
  AgentCode,
  AgentRuntime,
  AgentState,
  CameraMode,
  OfficeEvent,
  OfficeEventType,
  OfficeTask,
  RoomId,
} from '@renderer/components/office/types.js';
import { AGENTS, DESK_POSITIONS, MAX_EVENTS } from '@renderer/components/office/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInitialAgents(): Record<AgentCode, AgentRuntime> {
  const record = {} as Record<AgentCode, AgentRuntime>;

  for (const def of AGENTS) {
    const deskList = DESK_POSITIONS[def.defaultRoom];
    const deskPos: [number, number, number] =
      deskList && deskList[def.defaultDesk] != null
        ? deskList[def.defaultDesk]
        : [0, 0, 0];

    record[def.code] = {
      code: def.code,
      state: 'idle',
      currentRoom: def.defaultRoom,
      position: [...deskPos],
      targetPosition: [...deskPos],
      currentTask: null,
      taskProgress: 0,
      lastActivity: 'Initialised',
      lastActivityTime: Date.now(),
    };
  }

  return record;
}

// ---------------------------------------------------------------------------
// State interface
// ---------------------------------------------------------------------------

interface OfficeMetrics {
  cpu: number;
  memory: number;
  disk: number;
  uptime: number;
}

interface OfficeState {
  agents: Record<AgentCode, AgentRuntime>;
  tasks: OfficeTask[];
  events: OfficeEvent[];
  cameraMode: CameraMode;
  selectedRoom: RoomId | null;
  selectedAgent: AgentCode | null;
  metrics: OfficeMetrics;
  dramaEnabled: boolean;

  // Agent actions
  setAgentState: (code: AgentCode, state: AgentState) => void;
  setAgentPosition: (code: AgentCode, position: [number, number, number]) => void;
  setAgentTarget: (code: AgentCode, target: [number, number, number]) => void;
  setAgentTask: (code: AgentCode, task: string | null, progress?: number) => void;
  moveAgentToRoom: (code: AgentCode, room: RoomId, position?: [number, number, number]) => void;

  // Task actions
  addTask: (task: OfficeTask) => void;
  updateTask: (id: string, patch: Partial<OfficeTask>) => void;
  removeTask: (id: string) => void;

  // Event actions
  pushEvent: (event: OfficeEvent) => void;

  // Camera / selection actions
  selectRoom: (room: RoomId | null) => void;
  selectAgent: (code: AgentCode | null) => void;
  resetCamera: () => void;

  // System
  updateMetrics: (metrics: Partial<OfficeMetrics>) => void;
  setDramaEnabled: (enabled: boolean) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useOfficeStore = create<OfficeState>((set) => ({
  agents: buildInitialAgents(),
  tasks: [],
  events: [],
  cameraMode: 'overview',
  selectedRoom: null,
  selectedAgent: null,
  metrics: { cpu: 0, memory: 0, disk: 0, uptime: 0 },
  dramaEnabled: true,

  // --- Agent actions --------------------------------------------------------

  setAgentState: (code, state) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [code]: {
          ...s.agents[code],
          state,
          lastActivity: `State changed to ${state}`,
          lastActivityTime: Date.now(),
        },
      },
    })),

  setAgentPosition: (code, position) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [code]: { ...s.agents[code], position },
      },
    })),

  setAgentTarget: (code, targetPosition) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [code]: { ...s.agents[code], targetPosition, state: 'walking' },
      },
    })),

  setAgentTask: (code, task, progress = 0) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [code]: {
          ...s.agents[code],
          currentTask: task,
          taskProgress: progress,
          lastActivity: task ?? 'Task cleared',
          lastActivityTime: Date.now(),
        },
      },
    })),

  moveAgentToRoom: (code, room, position) => {
    const fallbackDesk = DESK_POSITIONS[room]?.[0] ?? ([0, 0, 0] as [number, number, number]);
    const dest: [number, number, number] = position ?? fallbackDesk;
    set((s) => ({
      agents: {
        ...s.agents,
        [code]: {
          ...s.agents[code],
          currentRoom: room,
          targetPosition: dest,
          state: 'walking',
          lastActivity: `Moving to ${room}`,
          lastActivityTime: Date.now(),
        },
      },
    }));
  },

  // --- Task actions ---------------------------------------------------------

  addTask: (task) =>
    set((s) => ({ tasks: [...s.tasks, task] })),

  updateTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  removeTask: (id) =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),

  // --- Event actions --------------------------------------------------------

  pushEvent: (event) =>
    set((s) => ({
      events: [event, ...s.events].slice(0, MAX_EVENTS),
    })),

  // --- Camera / selection ---------------------------------------------------

  selectRoom: (room) =>
    set({ selectedRoom: room, cameraMode: room ? 'room' : 'overview', selectedAgent: null }),

  selectAgent: (code) =>
    set({ selectedAgent: code, cameraMode: code ? 'follow' : 'overview' }),

  resetCamera: () =>
    set({ cameraMode: 'overview', selectedRoom: null, selectedAgent: null }),

  // --- System ---------------------------------------------------------------

  updateMetrics: (metrics) =>
    set((s) => ({ metrics: { ...s.metrics, ...metrics } })),

  setDramaEnabled: (enabled) => set({ dramaEnabled: enabled }),
}));

// Re-export types so consumers can import from the store module directly
export type { AgentCode, AgentState, CameraMode, OfficeEvent, OfficeEventType, OfficeTask, RoomId };

import { useEffect, useRef } from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import { AGENTS, DESK_POSITIONS } from '../constants.js';
import type { AgentCode, AgentState, OfficeEvent, RoomId } from '../types.js';
import {
  DRAMA_MESSAGES,
  DRAMA_KIND_TO_EVENT_TYPE,
  SAMPLE_TASKS,
  pickRandom,
  pickTwo,
  pickWeightedKind,
} from './DramaEvent.js';

/** Random interval between 8 000 and 15 000 ms */
function nextInterval(): number {
  return 8000 + Math.random() * 7000;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * DramaEngine — headless component that drives ambient office drama.
 * Renders nothing; must be mounted once inside the office scene tree.
 */
export function DramaEngine(): null {
  const dramaEnabled = useOfficeStore((s) => s.dramaEnabled);
  const pushEvent = useOfficeStore((s) => s.pushEvent);
  const setAgentState = useOfficeStore((s) => s.setAgentState);
  const setAgentTask = useOfficeStore((s) => s.setAgentTask);
  const moveAgentToRoom = useOfficeStore((s) => s.moveAgentToRoom);

  // Keep a stable ref to the latest dramaEnabled value so the interval
  // callback doesn't close over a stale boolean.
  const dramaRef = useRef(dramaEnabled);
  useEffect(() => { dramaRef.current = dramaEnabled; }, [dramaEnabled]);

  // Keep stable refs to store actions to avoid re-registering the interval
  const pushRef = useRef(pushEvent);
  const setStateRef = useRef(setAgentState);
  const setTaskRef = useRef(setAgentTask);
  const moveRef = useRef(moveAgentToRoom);

  useEffect(() => { pushRef.current = pushEvent; }, [pushEvent]);
  useEffect(() => { setStateRef.current = setAgentState; }, [setAgentState]);
  useEffect(() => { setTaskRef.current = setAgentTask; }, [setAgentTask]);
  useEffect(() => { moveRef.current = moveAgentToRoom; }, [moveAgentToRoom]);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    function tick(): void {
      if (dramaRef.current) {
        runDramaTick();
      }
      // Schedule next tick with a new random interval
      timeoutId = setTimeout(tick, nextInterval());
    }

    function runDramaTick(): void {
      const kind = pickWeightedKind();
      const eventType = DRAMA_KIND_TO_EVENT_TYPE[kind];
      const now = Date.now();

      let event: OfficeEvent | null = null;

      switch (kind) {
        case 'state-change': {
          const agent = pickRandom(AGENTS);
          const states: AgentState[] = ['working', 'thinking', 'idle'];
          const newState = pickRandom(states);
          setStateRef.current(agent.code, newState);

          const msgFn = newState === 'thinking' ? DRAMA_MESSAGES.thinking : undefined;
          const message = msgFn
            ? msgFn(agent.name)
            : `${agent.name} switched to ${newState}`;

          event = {
            id: makeId(),
            type: eventType,
            timestamp: now,
            agentCode: agent.code,
            targetAgentCode: null,
            message,
            room: agent.defaultRoom,
          };
          break;
        }

        case 'task-complete': {
          const agent = pickRandom(AGENTS);
          const task = pickRandom(SAMPLE_TASKS);
          setStateRef.current(agent.code, 'idle');
          setTaskRef.current(agent.code, null, 0);

          event = {
            id: makeId(),
            type: eventType,
            timestamp: now,
            agentCode: agent.code,
            targetAgentCode: null,
            message: DRAMA_MESSAGES.complete(agent.name, task),
            room: agent.defaultRoom,
          };
          break;
        }

        case 'agent-chat': {
          const [agentA, agentB] = pickTwo(AGENTS);
          setStateRef.current(agentA.code, 'talking');
          setStateRef.current(agentB.code, 'talking');

          // Revert to idle after 5 seconds
          setTimeout(() => {
            setStateRef.current(agentA.code, 'idle');
            setStateRef.current(agentB.code, 'idle');
          }, 5000);

          event = {
            id: makeId(),
            type: eventType,
            timestamp: now,
            agentCode: agentA.code,
            targetAgentCode: agentB.code,
            message: DRAMA_MESSAGES.chat(agentA.name, agentB.name),
            room: agentA.defaultRoom,
          };
          break;
        }

        case 'coffee-break': {
          const agent = pickRandom(AGENTS);
          const breakRoom: RoomId = 'break-room';
          const breakPos = DESK_POSITIONS[breakRoom]?.[0] ?? ([-6, 0, 15] as [number, number, number]);
          moveRef.current(agent.code, breakRoom, breakPos);
          setStateRef.current(agent.code, 'break');

          // Return to default room after 12 seconds
          setTimeout(() => {
            const deskPos = DESK_POSITIONS[agent.defaultRoom]?.[agent.defaultDesk]
              ?? DESK_POSITIONS[agent.defaultRoom]?.[0]
              ?? ([0, 0, 0] as [number, number, number]);
            moveRef.current(agent.code, agent.defaultRoom, deskPos);
            setStateRef.current(agent.code, 'idle');
          }, 12000);

          event = {
            id: makeId(),
            type: eventType,
            timestamp: now,
            agentCode: agent.code,
            targetAgentCode: null,
            message: DRAMA_MESSAGES.coffee(agent.name),
            room: breakRoom,
          };
          break;
        }

        case 'error': {
          const agent = pickRandom(AGENTS);
          setStateRef.current(agent.code, 'error');

          // Recover after 3 seconds
          setTimeout(() => {
            setStateRef.current(agent.code, 'working');
          }, 3000);

          event = {
            id: makeId(),
            type: eventType,
            timestamp: now,
            agentCode: agent.code,
            targetAgentCode: null,
            message: DRAMA_MESSAGES.error(agent.name),
            room: agent.defaultRoom,
          };
          break;
        }

        case 'nova-kuro-drama': {
          // Nova (SUDO-1) and Kuro (SUDO-2) special interactions
          const nova = AGENTS.find((a) => a.code === 'SUDO-1')!;
          const kuro = AGENTS.find((a) => a.code === 'SUDO-2')!;
          const isCrush = Math.random() < 0.5;
          const message = isCrush
            ? DRAMA_MESSAGES.crush(nova.name, kuro.name)
            : DRAMA_MESSAGES.rivalry(kuro.name, nova.name);

          const novaCode: AgentCode = 'SUDO-1';
          const kuroCode: AgentCode = 'SUDO-2';

          setStateRef.current(novaCode, 'thinking');
          setStateRef.current(kuroCode, 'thinking');

          setTimeout(() => {
            setStateRef.current(novaCode, 'idle');
            setStateRef.current(kuroCode, 'idle');
          }, 4000);

          event = {
            id: makeId(),
            type: eventType,
            timestamp: now,
            agentCode: novaCode,
            targetAgentCode: kuroCode,
            message,
            room: nova.defaultRoom,
          };
          break;
        }

        case 'meeting': {
          // Pick 3 agents for a meeting
          const shuffled = [...AGENTS].sort(() => Math.random() - 0.5);
          const attendees = shuffled.slice(0, 3);
          const meetingRoom: RoomId = 'meeting-room';
          const meetingPos = DESK_POSITIONS[meetingRoom]?.[0] ?? ([6, 0, -5] as [number, number, number]);

          for (const a of attendees) {
            moveRef.current(a.code, meetingRoom, meetingPos);
            setStateRef.current(a.code, 'talking');
          }

          // End meeting after 15 seconds
          setTimeout(() => {
            for (const a of attendees) {
              const deskPos = DESK_POSITIONS[a.defaultRoom]?.[a.defaultDesk]
                ?? DESK_POSITIONS[a.defaultRoom]?.[0]
                ?? ([0, 0, 0] as [number, number, number]);
              moveRef.current(a.code, a.defaultRoom, deskPos);
              setStateRef.current(a.code, 'idle');
            }
          }, 15000);

          event = {
            id: makeId(),
            type: eventType,
            timestamp: now,
            agentCode: attendees[0].code,
            targetAgentCode: null,
            message: DRAMA_MESSAGES.meeting(attendees.map((a) => a.name)),
            room: meetingRoom,
          };
          break;
        }

        case 'misc':
        default: {
          const agent = pickRandom(AGENTS);
          event = {
            id: makeId(),
            type: 'system-alert',
            timestamp: now,
            agentCode: agent.code,
            targetAgentCode: null,
            message: DRAMA_MESSAGES.thinking(agent.name),
            room: agent.defaultRoom,
          };
          break;
        }
      }

      if (event) {
        pushRef.current(event);
      }
    }

    // Start first tick
    timeoutId = setTimeout(tick, nextInterval());

    return () => {
      clearTimeout(timeoutId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export default DramaEngine;

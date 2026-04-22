import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import { ThreeElements } from '@react-three/fiber';
import type { OfficeTask } from '../types';

interface TaskBoardProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
}

// Fallback static tasks — used if the store has no tasks yet
const FALLBACK_TASKS: OfficeTask[] = [
  { id: 't1', title: 'Design spec',      assignedTo: null, status: 'done',        priority: 'high'   },
  { id: 't2', title: 'Build UI',         assignedTo: null, status: 'in-progress', priority: 'high'   },
  { id: 't3', title: 'Write tests',      assignedTo: null, status: 'queued',      priority: 'medium' },
  { id: 't4', title: 'Security audit',   assignedTo: null, status: 'queued',      priority: 'high'   },
  { id: 't5', title: 'Deploy staging',   assignedTo: null, status: 'in-progress', priority: 'medium' },
];

// Column definitions
const COLUMNS: { label: string; status: OfficeTask['status'][]; x: number; labelColor: string }[] = [
  { label: 'TODO',  status: ['queued'],      x: -0.65, labelColor: '#ef4444' },
  { label: 'DOING', status: ['in-progress', 'review'], x: 0.0,   labelColor: '#eab308' },
  { label: 'DONE',  status: ['done'],         x: 0.65,  labelColor: '#22c55e' },
];

function cardColorForStatus(status: OfficeTask['status'], priority: OfficeTask['priority']): string {
  if (status === 'done') return '#22c55e';
  if (priority === 'high') return '#ef4444';
  return '#eab308';
}

export function TaskBoard({ position = [0, 0, 0], rotation = [0, 0, 0] }: TaskBoardProps) {
  // Dynamically attempt to read from officeStore; fall back gracefully
  const tasks = useMemo<OfficeTask[]>(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@renderer/stores/officeStore') as { useOfficeStore?: () => { tasks?: OfficeTask[] } };
      if (mod && typeof mod.useOfficeStore === 'function') {
        const state = mod.useOfficeStore();
        if (state?.tasks && state.tasks.length > 0) return state.tasks;
      }
    } catch {
      // store not available — use fallback
    }
    return FALLBACK_TASKS;
  }, []);

  return (
    <group position={position} rotation={rotation as unknown as ThreeElements['group']['rotation']}>
      {/* Board backing */}
      <mesh position={[0, 1.5, 0]} castShadow>
        <boxGeometry args={[2, 1.5, 0.05]} />
        <meshStandardMaterial color='#111827' roughness={0.8} metalness={0.1} />
      </mesh>

      {/* Column dividers */}
      <mesh position={[-0.33, 1.5, 0.028]}>
        <boxGeometry args={[0.015, 1.4, 0.01]} />
        <meshStandardMaterial color='#374151' />
      </mesh>
      <mesh position={[0.33, 1.5, 0.028]}>
        <boxGeometry args={[0.015, 1.4, 0.01]} />
        <meshStandardMaterial color='#374151' />
      </mesh>

      {/* Column labels */}
      {COLUMNS.map((col) => (
        <group key={col.label} position={[col.x, 2.1, 0.04]}>
          <Html center>
            <div
              style={{
                color: col.labelColor,
                fontSize: '11px',
                fontWeight: 'bold',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                userSelect: 'none',
                textShadow: '0 0 4px #000',
              }}
            >
              {col.label}
            </div>
          </Html>
        </group>
      ))}

      {/* Task cards per column */}
      {COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => col.status.includes(t.status));
        return colTasks.map((task, rowIdx) => {
          const cardY = 1.95 - (rowIdx + 1) * 0.22;
          const cardColor = cardColorForStatus(task.status, task.priority);
          return (
            <group key={task.id} position={[col.x, cardY, 0.04]}>
              {/* Card body */}
              <mesh>
                <boxGeometry args={[0.55, 0.16, 0.02]} />
                <meshStandardMaterial color={cardColor} roughness={0.7} metalness={0.05} />
              </mesh>
              {/* Card label */}
              <group position={[0, 0, 0.012]}>
                <Html center>
                  <div
                    style={{
                      color: '#ffffff',
                      fontSize: '8px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      maxWidth: '60px',
                      textOverflow: 'ellipsis',
                      pointerEvents: 'none',
                      userSelect: 'none',
                      textShadow: '0 0 3px #000',
                    }}
                  >
                    {task.title.length > 14 ? task.title.slice(0, 12) + '\u2026' : task.title}
                  </div>
                </Html>
              </group>
            </group>
          );
        });
      })}

      {/* Outer frame */}
      <mesh position={[0, 1.5, 0.026]}>
        <boxGeometry args={[2.04, 1.54, 0.005]} />
        <meshStandardMaterial color='#374151' roughness={0.4} metalness={0.4} wireframe />
      </mesh>
    </group>
  );
}

export default TaskBoard;

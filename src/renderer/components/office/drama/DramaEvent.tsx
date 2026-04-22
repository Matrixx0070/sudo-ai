import type { OfficeEventType } from '../types.js';

/** Weight bucket for random event selection */
export interface DramaWeight {
  type: DramaEventKind;
  weight: number;
}

export type DramaEventKind =
  | 'state-change'
  | 'task-complete'
  | 'agent-chat'
  | 'coffee-break'
  | 'error'
  | 'nova-kuro-drama'
  | 'meeting'
  | 'misc';

/** Maps a DramaEventKind to the OfficeEventType used when pushing to the store */
export const DRAMA_KIND_TO_EVENT_TYPE: Record<DramaEventKind, OfficeEventType> = {
  'state-change':   'agent-state-change',
  'task-complete':  'task-completed',
  'agent-chat':     'agent-chat',
  'coffee-break':   'agent-break',
  'error':          'agent-error',
  'nova-kuro-drama':'agent-chat',
  'meeting':        'meeting-started',
  'misc':           'system-alert',
};

/** Weighted distribution matching the spec */
export const DRAMA_WEIGHTS: DramaWeight[] = [
  { type: 'state-change',   weight: 30 },
  { type: 'task-complete',  weight: 20 },
  { type: 'agent-chat',     weight: 15 },
  { type: 'coffee-break',   weight: 10 },
  { type: 'error',          weight: 10 },
  { type: 'nova-kuro-drama',weight: 5  },
  { type: 'meeting',        weight: 5  },
  { type: 'misc',           weight: 5  },
];

/** Human-readable message templates for each event kind */
export const DRAMA_MESSAGES = {
  coffee:   (agent: string) => `${agent} went to grab coffee ☕`,
  chat:     (a: string, b: string) => `${a} and ${b} are chatting 💬`,
  error:    (agent: string) => `${agent} hit a bug! Debugging... 🐛`,
  complete: (agent: string, task: string) => `${agent} completed: ${task} ✅`,
  review:   (a: string, b: string) => `${a} is reviewing ${b}'s code 👀`,
  thinking: (agent: string) => `${agent} is deep in thought 🤔`,
  break:    (agent: string) => `${agent} took a break 🛋️`,
  meeting:  (agents: string[]) => `${agents.join(', ')} started a meeting 🤝`,
  crush:    (a: string, b: string) => `${a} glanced at ${b}... 💕`,
  rivalry:  (a: string, b: string) => `${a} rejected ${b}'s PR again 😤`,
};

/** Sample task titles used for task-complete events */
export const SAMPLE_TASKS: string[] = [
  'Auth module refactor',
  'Fix CSS alignment bug',
  'Write unit tests',
  'Code review pass',
  'Security audit',
  'Performance profiling',
  'Update documentation',
  'Deploy to staging',
  'Implement dark mode',
  'Database migration',
];

/** Pick a random item from an array */
export function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Pick two distinct random items from an array */
export function pickTwo<T>(arr: T[]): [T, T] {
  const first = Math.floor(Math.random() * arr.length);
  let second = Math.floor(Math.random() * (arr.length - 1));
  if (second >= first) second += 1;
  return [arr[first], arr[second]];
}

/** Weighted random selection — returns the kind of event to generate */
export function pickWeightedKind(): DramaEventKind {
  const total = DRAMA_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
  let rand = Math.random() * total;
  for (const entry of DRAMA_WEIGHTS) {
    rand -= entry.weight;
    if (rand <= 0) return entry.type;
  }
  return 'misc';
}

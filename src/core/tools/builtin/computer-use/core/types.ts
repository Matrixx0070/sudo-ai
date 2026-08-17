/**
 * @file core/types.ts
 * @description Platform-independent contracts for the Computer Use Backend core:
 * Snapshot (a fused observation), UIElement (accessibility element), Action /
 * ActionPlan (typed intent with per-action expectations), and the executor's
 * step/recovery result types.
 *
 * These types sit ABOVE the per-platform driver line (IComputerUse). The
 * perception, grounding, executor, session and journal modules all speak these
 * types, so a new OS adapter never changes anything here.
 */

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

/** A single accessibility element, flattened from the AX tree with a stable index. */
export interface UIElement {
  /** Stable index within the snapshot (position in the flattened AX list). */
  i: number;
  /** AX role name, e.g. "push button", "entry", "menu item". */
  role: string;
  /** Accessible name / label (may be empty). */
  name: string;
  /** Subset of AX states present, e.g. ["visible","showing","enabled","focusable"]. */
  states: string[];
  /** Screen-pixel bounding box (x,y top-left; w,h size). -1 when unknown. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Owning application name, when known. */
  app: string;
}

/** An open top-level window (from the window manager / EWMH). */
export interface WindowInfo {
  /** Window id (hex string from wmctrl), when available. */
  id?: string;
  /** Window title. */
  title: string;
  /** Screen-pixel geometry, when available. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** True when this is the focused/active window. */
  active?: boolean;
}

/**
 * A fused observation of the screen at one instant. Cheap to diff: the
 * `hash` (of the screenshot bytes) plus the AX element signature let the
 * executor decide whether an action changed anything.
 */
export interface Snapshot {
  /** Monotonic snapshot id within a session. */
  seq: number;
  /** Wall-clock capture time (ms since epoch). */
  ts: number;
  /** Display this was captured from, e.g. ":99". */
  display: string;
  /** Base64 PNG of the full screen. */
  screenshot: string;
  /** Screenshot dimensions in pixels. */
  width: number;
  height: number;
  /** Content hash of the screenshot bytes (perceptual-ish: sha256 of PNG). */
  hash: string;
  /** Flattened accessibility elements (may be empty when AX is unavailable). */
  elements: UIElement[];
  /** Open windows. */
  windows: WindowInfo[];
  /** True when the AX channel produced elements (hybrid perception available). */
  axAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Action + expectation
// ---------------------------------------------------------------------------

export type ActionKind =
  | 'click'
  | 'double_click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'move'
  | 'wait'
  | 'focus_window'
  | 'screenshot';

/**
 * A target to ground into coordinates. Exactly one resolution path is chosen by
 * the GroundingResolver, in preference order: element index → AX text/role →
 * explicit coords → (vision, Phase 3).
 */
export interface Target {
  /** Direct AX element index from the current snapshot (highest precedence). */
  elementIndex?: number;
  /** Match an AX element by (case-insensitive substring) name. */
  text?: string;
  /** Constrain a text match to a role, e.g. "push button". */
  role?: string;
  /** Explicit pixel coordinates (fallback / precise placement). */
  x?: number;
  y?: number;
}

/**
 * A predicate the executor checks AFTER an action to decide success. All fields
 * are optional and ANDed together; an empty expectation means "any observable
 * change" (screenshot hash differs). This is the anti-silent-failure gate.
 */
export interface Expectation {
  /** The screenshot must change from the pre-action snapshot. */
  changed?: boolean;
  /** An AX element whose name contains this substring must appear. */
  appears?: string;
  /** An AX element whose name contains this substring must disappear. */
  disappears?: string;
  /** A window whose title contains this substring must be present. */
  windowTitle?: string;
  /** Free-text description for logs / vision verification (Phase 3). */
  describe?: string;
}

/** A single typed action with its target and post-condition. */
export interface Action {
  kind: ActionKind;
  /** Target for pointer actions (click/move/scroll anchor). */
  target?: Target;
  /** Text payload for `type`. */
  text?: string;
  /** Key/chord for `key`, e.g. "Return", "ctrl+a". */
  key?: string;
  /** Direction for `scroll`. */
  direction?: 'up' | 'down';
  /** Milliseconds for `wait`. */
  ms?: number;
  /** Window title (substring) for `focus_window`. */
  window?: string;
  /** Post-condition; when omitted the executor uses {changed:true}. */
  expect?: Expectation;
  /** Whether the action is safely re-runnable (affects recovery). Default true. */
  reversible?: boolean;
  /** Human-readable label for journals. */
  label?: string;
}

/** An ordered batch of actions pursuing one subgoal. */
export interface ActionPlan {
  subgoal: string;
  actions: Action[];
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

export type GroundingSource = 'element-index' | 'ax-text' | 'coords' | 'vision' | 'none';

export interface Grounded {
  x: number;
  y: number;
  /** 0..1 confidence in the resolution. */
  confidence: number;
  source: GroundingSource;
  /** The element that was matched, when applicable. */
  element?: UIElement;
  /** Why grounding failed, when x/y are absent. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Executor results
// ---------------------------------------------------------------------------

export type Verdict = 'ok' | 'expectation-failed' | 'grounding-failed' | 'refused' | 'error';

/** What the recovery ladder did after a failed step. */
export type RecoveryRung =
  | 'reground'
  | 'zoom-reground'
  | 'replan'
  | 'restart-subgoal'
  | 'escalate'
  | 'none';

export interface StepResult {
  action: Action;
  verdict: Verdict;
  grounded?: Grounded;
  /** Recovery attempts made (in order) before this verdict. */
  recovery: RecoveryRung[];
  /** Snapshot seq before / after the action. */
  beforeSeq: number;
  afterSeq: number;
  durationMs: number;
  message: string;
}

export interface PlanResult {
  subgoal: string;
  success: boolean;
  steps: StepResult[];
  /** Terminal reason when success is false. */
  reason?: string;
}

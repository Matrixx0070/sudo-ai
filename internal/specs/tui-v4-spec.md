# SUDO-AI TUI v4 — Architect Spec

**Status:** LOCKED — no feature additions, no removals.  
**Builder:** Single senior builder, 60-minute cap.  
**Stack:** TypeScript/ESM, Ink 7, React 19, `@inkjs/ui`, `ink-text-input`, `ink-spinner`, `marked`, `cli-highlight`, `nanoid`.  
**Gateway base URL:** `http://localhost:18900` (from `GATEWAY_URL` env var with fallback to this value).

---

## 1. Non-Goals

- **Not** redesigning any feature. The 10 locked features are implemented verbatim.
- **Not** wiring real tool events from `_streamAnthropic` / `_streamOpenAICompat` in this wave. Tool cards display against a typed in-process dispatcher; the backend stream wiring is a future wave.
- **Not** adding runtime npm dependencies. Zero new packages. All 10 features are buildable from the existing dep list.
- **Not** adding authentication or persistence beyond what already exists.

---

## 2. Color Palette (Canonical)

| Role | Value | Usage |
|---|---|---|
| Amber | `#e8b860` | Primary accent: brand, prompts, active signal dots, skill names |
| Green | `#7acc7a` | Success: done ring, GREEN alignment tier, healthy signal dots |
| Red | `#dd6666` | Error: fail ring, RED alignment tier, error messages, diff `-` lines |
| Dim white | `dimColor` (Ink prop) | Labels, hints, separators, collapsed tool previews |
| Default | (terminal default) | Body text, diff context lines |

No other hues. These five roles are the complete palette.

---

## 3. Component Tree

```
App (App.tsx)
├── Banner (components/Banner.tsx)           [NEW] welcome + first-run recap
├── Header (components/Header.tsx)           [MODIFY] add alignment dots + federation indicator
├── Rule (components/Rule.tsx)               [NO CHANGE]
├── MessageList
│   └── Message (components/Message.tsx)     [MODIFY] add ToolCallCard inside message
│       └── ToolCallCard (components/ToolCallCard.tsx) [NEW] status ring + timer + diff
├── Rule (components/Rule.tsx)               [NO CHANGE]
├── Spinner (components/GerundSpinner.tsx)   [NEW] thinking/searching gerund
├── Composer row
│   ├── Input (components/Input.tsx)         [MODIFY] add skills bar right side
│   ├── SlashMenu (components/SlashMenu.tsx) [NEW] filterable overlay above input
│   └── MentionMenu (components/MentionMenu.tsx) [NEW] @filename filterable overlay
├── PermissionDialog (components/PermissionDialog.tsx) [NEW] y/n/a tool approval
├── HelpOverlay (components/HelpOverlay.tsx) [MODIFY] add new slash commands
├── AlignmentModal (components/AlignmentModal.tsx) [NEW] Ctrl+A digest detail
├── FederationModal (components/FederationModal.tsx) [NEW] Ctrl+F peer list
└── SkillPicker (components/SkillPicker.tsx) [NEW] Ctrl+S skill selection
```

---

## 4. File Ownership Map

Single builder owns all of these exclusively. Integrator touches nothing except running `tsc --noEmit`.

| File | Status | Description |
|---|---|---|
| `/root/sudo-ai-v4/src/cli/commands/chat/App.tsx` | MODIFY | State machine, keyboard routing, hook wiring |
| `/root/sudo-ai-v4/src/cli/commands/chat/provider.ts` | MODIFY | Extend `ProviderChunk` union with tool event types |
| `/root/sudo-ai-v4/src/cli/commands/chat/markdown.ts` | NO CHANGE | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/Header.tsx` | MODIFY | Alignment dots, federation indicator, Ctrl+A/Ctrl+F shortcuts |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/Input.tsx` | MODIFY | Skills bar right side, expose `onSlash` / `onMention` callbacks |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/Message.tsx` | MODIFY | Accept `toolCards` prop, render `ToolCallCard` |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/Rule.tsx` | NO CHANGE | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/Panel.tsx` | NO CHANGE | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/HelpOverlay.tsx` | MODIFY | Add new slash commands to list |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/Banner.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/GerundSpinner.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/ToolCallCard.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/SlashMenu.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/MentionMenu.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/PermissionDialog.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/AlignmentModal.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/FederationModal.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/components/SkillPicker.tsx` | NEW | |
| `/root/sudo-ai-v4/src/cli/commands/chat/hooks/useDigest.ts` | NEW | Polls /v1/admin/digest every 30s |
| `/root/sudo-ai-v4/src/cli/commands/chat/hooks/useFederation.ts` | NEW | Polls /v1/federation/peers every 30s |
| `/root/sudo-ai-v4/src/cli/commands/chat/hooks/useSkills.ts` | NEW | Polls /v1/skills every 30s |
| `/root/sudo-ai-v4/src/cli/commands/chat/hooks/useFilePicker.ts` | NEW | Scans cwd for @filename autocomplete |
| `/root/sudo-ai-v4/src/cli/commands/chat/dispatcher.ts` | NEW | In-memory tool event dispatcher for demo tool cards |

---

## 5. Data Models and Type Contracts

### 5.1 Extended ProviderChunk (provider.ts)

```typescript
// Add to existing union — do NOT remove StreamChunk or DoneChunk
export interface ToolStartChunk {
  type: 'tool_start';
  toolId: string;        // unique per invocation, e.g. nanoid()
  toolName: string;      // e.g. "bash"
  args: string;          // stringified args for display
  gerund: string;        // e.g. "Running…", "Searching…", "Reading…"
}

export interface ToolEndChunk {
  type: 'tool_end';
  toolId: string;
  resultPreview: string;   // first line / summary of result
  resultFull: string;      // full output for expandable diff
  isDiff: boolean;         // true → render InlineDiff
  elapsedMs: number;
}

export interface ToolErrorChunk {
  type: 'tool_error';
  toolId: string;
  error: string;
  elapsedMs: number;
}

export interface ToolPermissionChunk {
  type: 'tool_permission_request';
  toolId: string;
  toolName: string;
  args: string;           // human-readable for dialog: e.g. "rm -rf /foo"
}

export type ProviderChunk = StreamChunk | DoneChunk
  | ToolStartChunk | ToolEndChunk | ToolErrorChunk | ToolPermissionChunk;
```

### 5.2 ToolCallCard shape (ToolCallCard.tsx, Message.tsx)

```typescript
// Replaces and extends the legacy ToolCall interface in Message.tsx
export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolCallCard {
  toolId: string;
  name: string;
  args: string;
  status: ToolStatus;
  elapsedMs: number;
  resultPreview: string;   // "15 lines" or first line summary
  resultFull: string;
  isDiff: boolean;
  expanded: boolean;       // toggled by Ctrl+O
}
```

### 5.3 Digest shape (useDigest.ts)

```typescript
export interface DigestSignal {
  name: 'veto' | 'trust' | 'commits' | 'epistemic' | 'calibration' | 'discordance' | 'reanchor' | 'brier';
  color: '#7acc7a' | '#e8b860' | '#dd6666';   // green / amber / red
  value: number;
}

export interface DigestData {
  signals: DigestSignal[];    // exactly 8, one per name
  overall: 'GREEN' | 'AMBER' | 'RED';
  raw: unknown;               // full /v1/admin/digest response
}
```

Failure policy: on fetch error or HTTP non-2xx → return previous `DigestData` unchanged (initial state: 8 amber dots, overall AMBER). Never surface the exception in the UI.

### 5.4 Federation shape (useFederation.ts)

```typescript
export interface Peer {
  id: string;
  url: string;
  status: 'connected' | 'degraded' | 'offline';
}

export interface FederationData {
  peers: Peer[];
  count: number;
}
```

Failure policy: on error → `{ peers: [], count: 0 }`. Header shows `peers · 0`.

### 5.5 Skills shape (useSkills.ts)

```typescript
export interface Skill {
  name: string;
  description: string;
  trust_tier?: string;
}

export interface SkillsData {
  skills: Skill[];
  active: Skill | null;  // currently selected skill
}
```

Failure policy: on error → `{ skills: [], active: null }`. Input row shows nothing.

---

## 6. Chat State Machine

Discriminated union. All states carry the current `messages` array to avoid prop drilling.

```typescript
type ChatPhase =
  | { tag: 'idle' }
  | { tag: 'streaming';          assistantMsgId: string; gerund: string }
  | { tag: 'tool_running';       toolId: string; toolName: string; gerund: string }
  | { tag: 'awaiting_approval';  toolId: string; toolName: string; args: string }
  | { tag: 'cancelled' };
```

### State transitions

| From | Event | To | Notes |
|---|---|---|---|
| `idle` | user submits text | `streaming` | gerund defaults to "Thinking…" |
| `streaming` | first text token | `streaming` | gerund stays, isThinking clears |
| `streaming` | `tool_permission_request` chunk | `awaiting_approval` | stream paused |
| `streaming` | `tool_start` chunk (auto-approved) | `tool_running` | gerund set from chunk |
| `streaming` | `done` chunk | `idle` | |
| `streaming` | Ctrl+C | `cancelled` then `idle` | append "[cancelled]" to msg |
| `awaiting_approval` | key `y` or `Y` | `tool_running` | single keypress |
| `awaiting_approval` | key `a` or `A` | `tool_running` | add to always-allow list |
| `awaiting_approval` | key `n` or `N` | `idle` | dismiss, no tool run |
| `tool_running` | `tool_end` chunk | `streaming` | resume stream |
| `tool_running` | `tool_error` chunk | `streaming` | append error card, resume |
| `tool_running` | Ctrl+C | `cancelled` then `idle` | |
| `cancelled` | (immediate) | `idle` | transient, clean up refs |

The `idle` state is the only state where the input accepts text. The `awaiting_approval` state captures raw single-key input for y/n/a. All other states suppress input.

---

## 7. Data Flow

| Source | Hook | Interval | Consumers | Failure Behavior |
|---|---|---|---|---|
| `GET /v1/admin/digest` | `useDigest()` | 30s | `Header` (8 dots), `AlignmentModal` | Keep last value; initial = 8 amber dots |
| `GET /v1/federation/peers` | `useFederation()` | 30s | `Header` (count), `FederationModal` | `count: 0`, empty peer list |
| `GET /v1/skills` | `useSkills()` | 30s | `Input` (skills bar), `SkillPicker` | Empty list, no active skill |
| `fs.readdirSync(cwd)` | `useFilePicker()` | On `@` keypress | `MentionMenu` | Empty list, no overlay |
| In-process `dispatcher.ts` | direct event | Per tool event | `App` (state machine), `Message` (tool cards) | No network; never fails |

All polling hooks use `useEffect` with `setInterval`. Each hook accepts a `baseUrl: string` parameter defaulting to `process.env['GATEWAY_URL'] ?? 'http://localhost:18900'`. Authorization header: `Bearer ${process.env['GATEWAY_TOKEN'] ?? ''}` — passed as-is; empty string if not set.

---

## 8. Component Contracts

### 8.1 Banner (NEW)

```typescript
interface BannerProps {
  model: string;
  providerLabel: string;
  connectedProviders: string[];   // e.g. ["Anthropic", "Local"]
  lastSessionSummary: string | null;  // null on fresh install
  onDismiss: () => void;
}
```

Renders as a dim-bordered box at the top of the message list. Dismissed on first keypress of any printable character or Enter. Stores dismissal in `sessionStorage`-equivalent (React `useRef` per process — no file I/O needed). Subsequent `chat` invocations in the same process skip the banner.

### 8.2 Header (MODIFY)

```typescript
interface HeaderProps {
  model: string;
  alignment: AlignmentStatus;           // kept for legacy Panel compat
  tokens: number;
  digest: DigestData;                   // NEW
  federation: FederationData;           // NEW
  onAlignmentOpen: () => void;          // NEW — Ctrl+A callback
  onFederationOpen: () => void;         // NEW — Ctrl+F callback
}
```

Renders the single header line:

```
  sudo · model-name ●●●●●●●● GREEN  peers · 3  1234t
```

The 8 dots are rendered with the individual signal colors from `digest.signals`. Clicking through `Ctrl+A` opens `AlignmentModal`; `Ctrl+F` opens `FederationModal`. Keyboard bindings live in `App.tsx`; Header receives callbacks.

**Truncation at narrow terminals:**
- Width >= 120: full render as above
- Width 100-119: drop "peers ·" label, show only count: `·3`
- Width < 100: show only model's last path segment (after last `/` or `.`), hide peer count

Width is read from `process.stdout.columns ?? 120` at render time (re-reads each render).

### 8.3 GerundSpinner (NEW)

```typescript
interface GerundSpinnerProps {
  gerund: string;   // e.g. "Thinking…", "Searching…", "Running…", "Reading…"
  elapsedMs: number;
}
```

Uses `ink-spinner` (`type="dots"`). Renders: `⠋ Thinking… 1.2s` using amber color for the elapsed time. Placed between `MessageList` and bottom `Rule`. Only rendered when `phase.tag === 'streaming' || phase.tag === 'tool_running'`.

Gerund-to-tool mapping (builder may extend):
- No tool context → "Thinking…"
- `tool_start` with name containing "search" / "grep" / "find" → "Searching…"
- `tool_start` with name "bash" / "exec" / "run" → "Running…"
- `tool_start` with name "read" / "cat" / "view" → "Reading…"
- `tool_start` with name "write" / "edit" / "create" → "Writing…"
- Any other tool → "Working…"

### 8.4 ToolCallCard (NEW, rendered inside Message)

```typescript
interface ToolCallCardProps {
  card: ToolCallCard;
  onToggleExpand: (toolId: string) => void;
}
```

Status ring characters:
- `running`: `○` amber
- `done`: `●` green (`#7acc7a`)
- `error`: `✖` red (`#dd6666`)

Collapsed render (1 line):
```
  ⏺ bash(rm -rf /foo)  ○  843ms  ⎿ 3 lines
```

Expanded render (`card.expanded === true`, toggled by `Ctrl+O` in App):
- If `card.isDiff === false`: show `resultFull` as dim text, 4-space indent, wrapped at 76
- If `card.isDiff === true`: render inline diff (see §8.5)

`Ctrl+O` in `App.tsx` toggles `expanded` on the most-recently-used tool card (last in messages where `role === 'tool'`).

### 8.5 InlineDiff renderer (inside ToolCallCard)

Inline — no separate file needed; lives inside `ToolCallCard.tsx`.

Parse `resultFull` line by line:
- Lines starting with `+` → green `#7acc7a`, 2-space indent
- Lines starting with `-` → red `#dd6666`, 2-space indent
- Lines starting with `@@` → dim, 2-space indent
- All other lines → default, 2-space indent

```typescript
function renderDiff(raw: string): React.ReactElement
```

### 8.6 SlashMenu (NEW)

```typescript
const SLASH_COMMANDS = [
  { cmd: '/help',       desc: 'Show help' },
  { cmd: '/clear',      desc: 'Clear conversation history' },
  { cmd: '/model',      desc: 'Switch model' },
  { cmd: '/panel',      desc: 'Toggle info panel' },
  { cmd: '/skills',     desc: 'Open skill picker' },
  { cmd: '/alignment',  desc: 'Open alignment digest' },
  { cmd: '/federation', desc: 'Open federation peers' },
  { cmd: '/exit',       desc: 'Exit chat' },
] as const;

interface SlashMenuProps {
  filter: string;             // text after '/'
  selectedIndex: number;
  onSelect: (cmd: string) => void;
  onClose: () => void;
}
```

Rendered above the `Input` row as a `borderStyle="single"` box, `borderColor="#e8b860"`, max 8 entries. Filtered by `filter` (case-insensitive prefix match). Arrow up/down changes `selectedIndex`. Enter selects, Escape closes. Input in `App.tsx` detects first character `/` and opens this menu; subsequent characters update `filter`. Selecting an entry inserts the command text into the input field.

### 8.7 MentionMenu (NEW)

```typescript
interface MentionMenuProps {
  filter: string;           // text after '@'
  entries: string[];        // file paths from useFilePicker
  selectedIndex: number;
  onSelect: (path: string) => void;
  onClose: () => void;
}
```

Triggered when user types `@` in the input. `useFilePicker` does a synchronous `fs.readdirSync(process.cwd())` filtered to the first 20 entries, then filtered further by `filter`. Selecting inserts `@filename` as a tokenized mention (amber color) into the input via a `mentions: string[]` array tracked in `App` state. The displayed input value shows `@filename` as plain text; rendering is amber-colored via a custom display wrapper in `Input.tsx`.

### 8.8 PermissionDialog (NEW)

```typescript
interface PermissionDialogProps {
  toolName: string;
  args: string;
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
}
```

Rendered as a centered `borderStyle="round"` box with `borderColor="#e8b860"`. Does not use absolute positioning (Ink does not support it); rendered inline between `MessageList` and `GerundSpinner`. Only shown when `phase.tag === 'awaiting_approval'`. Captures key input in `App.tsx` `useInput` handler — `y/Y` → `onAllow`, `n/N` → `onDeny`, `a/A` → `onAlwaysAllow`.

Content:
```
╭───────────────────────────────────────────────╮
│  Allow bash `rm -rf /foo`?                    │
│  [Y]es  [N]o  [A]lways                        │
╰───────────────────────────────────────────────╯
```

### 8.9 AlignmentModal (NEW)

```typescript
interface AlignmentModalProps {
  digest: DigestData;
  onClose: () => void;
}
```

`borderStyle="single"`, `borderColor="#e8b860"`. Shows each of 8 signal rows: name, colored dot, value. Bottom line: `Ctrl+A to close`. Opened by `Ctrl+A` in `App.tsx`. Shown as an overlay inside the layout — render it in place of the full message list (not floating; push content down).

### 8.10 FederationModal (NEW)

```typescript
interface FederationModalProps {
  federation: FederationData;
  onClose: () => void;
}
```

`borderStyle="single"`, `borderColor="#e8b860"`. Shows each peer: id (truncated to 24 chars), url, status (green connected / amber degraded / red offline). `Ctrl+F` to close.

### 8.11 SkillPicker (NEW)

```typescript
interface SkillPickerProps {
  skills: Skill[];
  activeSkill: Skill | null;
  onSelect: (skill: Skill | null) => void;
  onClose: () => void;
}
```

`borderStyle="single"`, `borderColor="#e8b860"`. Arrow keys navigate. Enter selects, `Ctrl+S` or Escape closes. Selecting `null` entry (first row: "none") clears active skill. When a skill is active, `Input.tsx` renders `· skill-name` right-aligned in the hints bar, in amber.

### 8.12 Input (MODIFY)

```typescript
interface InputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  disabled: boolean;
  activeSkill: Skill | null;    // NEW — for skills bar
  onSlashOpen: () => void;      // NEW — triggered when '/' detected
  onMentionOpen: () => void;    // NEW — triggered when '@' detected
}
```

Right-side hints bar updated:
```
⌃K cmds  ⌃\ panel  ⌃D exit · skill-name
```
The `· skill-name` segment only appears when `activeSkill \!== null`. Color: amber for skill name, dim for separator.

---

## 9. App.tsx State Shape

Add to existing state in `App.tsx`:

```typescript
// New state fields (add alongside existing)
const [phase, setPhase]     // extend AppPhase to include all ChatPhase tags
const [digest, setDigest]   = useState<DigestData>(initialDigest);
const [federation, setFed]  = useState<FederationData>({ peers: [], count: 0 });
const [skills, setSkills]   = useState<SkillsData>({ skills: [], active: null });
const [toolCards, setToolCards] = useState<Map<string, ToolCallCard>>(new Map());
const [showBanner, setShowBanner] = useState<boolean>(true);  // false after first input
const [showAlignmentModal, setShowAlignmentModal] = useState(false);
const [showFederationModal, setShowFederationModal] = useState(false);
const [showSkillPicker, setShowSkillPicker] = useState(false);
const [slashFilter, setSlashFilter] = useState<string | null>(null);  // null = closed
const [mentionFilter, setMentionFilter] = useState<string | null>(null);
const [alwaysAllowTools, setAlwaysAllowTools] = useState<Set<string>>(new Set());
const phaseRef = useRef<ChatPhase>({ tag: 'idle' });  // non-reactive copy for event handlers
```

`AppPhase` is collapsed — `ChatPhase` replaces the `'chat'` value. The `'splash'` → `'chat'` transition happens as before (120ms timer), then the sub-machine takes over.

Messages array extended to carry tool cards per message:

```typescript
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  toolCards?: ToolCallCard[];  // NEW — ordered list of tool calls within this message
}
```

---

## 10. New Keyboard Bindings in App.tsx

Add to the existing `useInput` handler:

| Binding | Action |
|---|---|
| `Ctrl+A` | Toggle `showAlignmentModal` (only when `phase.tag === 'idle'`) |
| `Ctrl+F` | Toggle `showFederationModal` (only when `phase.tag === 'idle'`) |
| `Ctrl+S` | Toggle `showSkillPicker` (only when `phase.tag === 'idle'`) |
| `Ctrl+O` | Toggle expand on last tool card in last assistant message |
| `/` (first char) | Set `slashFilter = ''` to open SlashMenu |
| `@` (in middle) | Set `mentionFilter = ''` to open MentionMenu |
| `Escape` | Close any open overlay (slash/mention/alignment/federation/skill) |
| `y` / `n` / `a` | When `phase.tag === 'awaiting_approval'`: approve / deny / always-allow |

Detection of `/` and `@`: inside `Input`'s `onChange` handler, detect the first character typed as `/` (only when input was empty) and any `@` character. Callbacks are passed to `Input` as `onSlashOpen` and `onMentionOpen`.

---

## 11. New Slash Commands

Add to `handleSlashCommand` in `App.tsx`:

| Command | Handler |
|---|---|
| `/panel` | Toggle `showPanel` (existing logic, add alias) |
| `/skills` | Set `showSkillPicker = true` |
| `/alignment` | Set `showAlignmentModal = true` |
| `/federation` | Set `showFederationModal = true` |

Also update `HelpOverlay.tsx` to include these 4 new entries.

---

## 12. Hooks API

### useDigest

```typescript
// /root/sudo-ai-v4/src/cli/commands/chat/hooks/useDigest.ts
export function useDigest(baseUrl: string): DigestData
```

- Polls `GET ${baseUrl}/v1/admin/digest` every 30 000 ms
- Auth: `Authorization: Bearer ${process.env['GATEWAY_TOKEN'] ?? ''}`
- On success: parse `data.signals` array of `{name, score}` objects, map score to color (>=0.7 green, >=0.4 amber, <0.4 red)
- On error or non-200: return previous value; no retry until next interval
- Initial value: `{ signals: [8 amber dots], overall: 'AMBER', raw: null }`

### useFederation

```typescript
// /root/sudo-ai-v4/src/cli/commands/chat/hooks/useFederation.ts
export function useFederation(baseUrl: string): FederationData
```

- Polls `GET ${baseUrl}/v1/federation/peers` every 30 000 ms
- On error: `{ peers: [], count: 0 }`

### useSkills

```typescript
// /root/sudo-ai-v4/src/cli/commands/chat/hooks/useSkills.ts
export function useSkills(baseUrl: string): SkillsData & { setActive: (s: Skill | null) => void }
```

- Polls `GET ${baseUrl}/v1/skills` every 30 000 ms
- Returns skills list + local `setActive` mutator
- On error: `{ skills: [], active: null }`

### useFilePicker

```typescript
// /root/sudo-ai-v4/src/cli/commands/chat/hooks/useFilePicker.ts
export function useFilePicker(filter: string | null): string[]
```

- `filter === null` → returns `[]` (disabled)
- When `filter \!== null`: synchronous `fs.readdirSync(process.cwd())` (catches errors, returns `[]`), filtered to entries matching `filter` prefix, max 20 entries
- Returns plain filename strings (not full paths for display; full path on selection)

---

## 13. dispatcher.ts (Demo Tool Event Bus)

```typescript
// /root/sudo-ai-v4/src/cli/commands/chat/dispatcher.ts
type ToolEventHandler = (event: ToolStartChunk | ToolEndChunk | ToolErrorChunk | ToolPermissionChunk) => void;

export const dispatcher: {
  on: (handler: ToolEventHandler) => () => void;    // returns unsubscribe fn
  emit: (event: ToolStartChunk | ToolEndChunk | ToolErrorChunk | ToolPermissionChunk) => void;
  emitDemo: () => void;  // fires a 3-step demo sequence for testing
}
```

`App.tsx` subscribes to `dispatcher.on` on mount (and unsubscribes on unmount). The `chatStream` generator does NOT yet call `dispatcher.emit` — that wiring is a future wave. `emitDemo()` fires `tool_start` → (500ms) `tool_end` for testing without a live gateway.

---

## 14. ASCII Screen Mockups

### (A) Steady-state chat — tool card + diff + all SUDO-AI signature features visible

```
  sudo · claude-sonnet-4-6 ●●●●●●●● GREEN  peers · 3  4231t
  ────────────────────────────────────────────────────────────────────────────

  you
    Show me the diff for the last file I edited

  sudo
    I ran a read on the file. Here's what changed:

    ⏺ bash(git diff HEAD~1)  ●  412ms  ⎿ 8 lines (expanded below)
      ──────────────────────────────────────────────────────────────────────
        @@ -12,6 +12,8 @@ export const App: React.FC = () => {
         const [phase, setPhase] = useState<AppPhase>('splash');
        -  const [alignment] = useState<AlignmentStatus>('green');
        +  const [digest, setDigest] = useState<DigestData>(initialDigest);
        +  const [federation, setFed] = useState<FederationData>({ peers: [], count: 0 });
      ──────────────────────────────────────────────────────────────────────

    The `alignment` field has been replaced with the live digest. Two
    new state variables are now sourced from polling hooks.

  ⠙ Thinking…  1.4s

  ────────────────────────────────────────────────────────────────────────────
  ›                                                     ⌃K cmds  ⌃\ panel  ⌃D exit · code-refactor
```

### (B) Slash command menu open

```
  sudo · claude-sonnet-4-6 ●●●●●●●● GREEN  peers · 3  4231t
  ────────────────────────────────────────────────────────────────────────────

  you
    how do I write a loop in bash?

  sudo
    In bash, you have three main loop types: for, while, and until...

  ────────────────────────────────────────────────────────────────────────────
  ┌─ commands ──────────────────────────────────────────────────────────────┐
  │  /help        Show help                                                 │
  │  /clear       Clear conversation history                                │
  │  /model       Switch model                                              │
  │  /panel       Toggle info panel                                         │
  │  /skills      Open skill picker                          ← selected     │
  │  /alignment   Open alignment digest                                     │
  │  /federation  Open federation peers                                     │
  │  /exit        Exit chat                                                 │
  └─────────────────────────────────────────────────────────────────────────┘
  ›  /sk                                                ⌃K cmds  ⌃\ panel  ⌃D exit
```

### (C) Permission dialog

```
  sudo · claude-sonnet-4-6 ●●●●●●●● GREEN  peers · 3  4231t
  ────────────────────────────────────────────────────────────────────────────

  you
    Delete the temp files in /tmp/build

  sudo
    I can do that. I'll need permission to run the command.

  ╭──────────────────────────────────────────────────────────────────────────╮
  │                                                                          │
  │   Allow bash `rm -rf /tmp/build`?                                        │
  │                                                                          │
  │   [Y]es   [N]o   [A]lways                                                │
  │                                                                          │
  ╰──────────────────────────────────────────────────────────────────────────╯
  ────────────────────────────────────────────────────────────────────────────
  ›  _                                                  ⌃K cmds  ⌃\ panel  ⌃D exit
```

---


### (D) First-run banner + @filename mention menu

```
  sudo · claude-sonnet-4-6 ●●●●●●●● AMBER  peers · 0  0t
  ────────────────────────────────────────────────────────────────────────────
  ┌─ welcome ───────────────────────────────────────────────────────────────┐
  │  SUDO-AI  claude-sonnet-4-6  via Anthropic                              │
  │  Connected providers: Anthropic                                         │
  │  No previous session.                                                   │
  │                                                                         │
  │  Type a message to begin. /help for commands.                           │
  │  (press any key to dismiss)                                             │
  └─────────────────────────────────────────────────────────────────────────┘

  ────────────────────────────────────────────────────────────────────────────
  ┌─ files ─────────────────────────────────────────────────────────────────┐
  │  App.tsx                                                                │
  │  components/                                                            │
  │  markdown.ts                                                            │
  │  provider.ts                             ← selected                     │
  └─────────────────────────────────────────────────────────────────────────┘
  ›  read @prov                                         ⌃K cmds  ⌃\ panel  ⌃D exit
```

Features visible: 5 (welcome banner, top box), 6 (@filename mention menu, bottom overlay).
Alignment dots start amber (initial state before first digest poll).
Peers shows 0 (initial state before first federation poll).

---

## 15. npm Dependency Assessment

Zero new dependencies required. Confirm against current `package.json`:

| Feature | Required package | Available |
|---|---|---|
| Spinner (feature 4) | `ink-spinner` | YES — `"ink-spinner": "^5.0.0"` |
| Text input (feature 2, 6) | `ink-text-input` | YES — `"ink-text-input": "^6.0.0"` |
| Diff colors | `ink` `<Text color>` | YES |
| Autocomplete overlays | `ink` `<Box>` + `useInput` | YES |
| Polling | native `setInterval` + `fetch` | YES |
| File scan | `node:fs` | YES |
| ID generation | `nanoid` | YES |
| Spinner types | `@inkjs/ui` (optional) | YES |

The builder must not add any packages to `package.json`.

---

## 16. 100×35 Minimum Terminal Compliance

All components must render without horizontal overflow at 100 columns × 35 rows.

Rules:
1. `Rule.tsx` uses `'─'.repeat(76)` + 2-space margin = 78 chars total. Safe.
2. `SlashMenu`: `borderStyle="single"` box with `width={Math.min(process.stdout.columns - 4, 80)}`. Fits at 100.
3. `PermissionDialog`: `width={Math.min(process.stdout.columns - 4, 78)}`. Fits at 100.
4. `AlignmentModal`, `FederationModal`, `SkillPicker`: same `Math.min` pattern.
5. `Header` truncation: see §8.2 for cascade rules at <120 / <100 columns.
6. `ToolCallCard` collapsed line: 76 chars max including all fields. If tool name + args > 40 chars, truncate args with `…`.
7. All overlays rendered inline (Ink does not support absolute positioning). The layout stacks vertically; overlays push content rather than float.

---

## 17. Acceptance Criteria

Each criterion is independently testable via `vitest` unit test or manual terminal verification.

**Feature 1 — Tool-call cards**
- [ ] A `ToolCallCard` with `status='running'` renders `○` in amber
- [ ] A `ToolCallCard` with `status='done'` renders `●` in green (`#7acc7a`)
- [ ] A `ToolCallCard` with `status='error'` renders `✖` in red
- [ ] Elapsed ms counter is displayed next to status ring
- [ ] `⎿ N lines` preview is shown in collapsed state
- [ ] `Ctrl+O` toggles `expanded` on the last tool card (unit test via state mutation)

**Feature 2 — Slash autocomplete**
- [ ] Typing `/` with empty input opens `SlashMenu`
- [ ] Typing `/sk` filters to `/skills` only
- [ ] Arrow up/down changes `selectedIndex`
- [ ] Enter inserts selected command into input field
- [ ] Escape closes `SlashMenu` without inserting
- [ ] All 8 commands are present in the list

**Feature 3 — Permission dialog**
- [ ] `phase.tag === 'awaiting_approval'` renders `PermissionDialog`
- [ ] Key `y` calls `onAllow` and transitions to `tool_running`
- [ ] Key `n` calls `onDeny` and transitions to `idle`
- [ ] Key `a` calls `onAlwaysAllow`, adds to `alwaysAllowTools`, transitions to `tool_running`
- [ ] Input row is suppressed during `awaiting_approval`

**Feature 4 — Gerund spinner**
- [ ] `GerundSpinner` renders only when `phase.tag === 'streaming' || 'tool_running'`
- [ ] Gerund text maps correctly for tool names: bash→"Running…", grep→"Searching…", read→"Reading…"
- [ ] Elapsed time displayed in amber

**Feature 5 — Welcome banner**
- [ ] `Banner` is rendered on first chat invocation (unit: `showBanner` initial = true)
- [ ] `Banner` shows model name, provider label, connected providers
- [ ] `Banner` is dismissed on first printable keypress (unit: simulate key event)
- [ ] `Banner` is not re-shown after dismissal within the same process

**Feature 6 — @filename autocomplete**
- [ ] Typing `@` in input opens `MentionMenu`
- [ ] `useFilePicker` returns cwd entries matching `filter`
- [ ] Selecting an entry inserts `@filename` into input text
- [ ] The inserted mention appears in amber color in the input row

**Feature 7 — Inline diff renderer**
- [ ] Lines starting with `+` render in green (`#7acc7a`)
- [ ] Lines starting with `-` render in red (`#dd6666`)
- [ ] Lines starting with `@@` render dim
- [ ] Other lines render in default color
- [ ] Diff only rendered when `card.isDiff === true`

**Feature 8 — Alignment strip**
- [ ] Header shows exactly 8 colored dots
- [ ] Each dot color matches `DigestSignal.color` for its signal
- [ ] Dots refresh on 30s interval (unit: mock `setInterval`, verify state update)
- [ ] `Ctrl+A` opens `AlignmentModal`
- [ ] `AlignmentModal` shows all 8 signal names and values
- [ ] On fetch failure, previous dots remain (no crash, no empty render)

**Feature 9 — Federation indicator**
- [ ] Header shows `peers · N` where N matches `federation.count`
- [ ] `Ctrl+F` opens `FederationModal`
- [ ] `FederationModal` lists peer id, url, status
- [ ] On fetch failure, shows `peers · 0`

**Feature 10 — Skills bar**
- [ ] When `activeSkill \!== null`, Input row shows `· skill-name` in amber
- [ ] `Ctrl+S` opens `SkillPicker`
- [ ] Selecting a skill sets it as active and closes picker
- [ ] Selecting "none" clears active skill
- [ ] On fetch failure, skills list is empty but UI does not crash

**Infrastructure**
- [ ] `tsc --noEmit` exits 0 across entire project
- [ ] All existing tests in `tests/` continue to pass (`vitest run`)
- [ ] No new entries in `package.json` dependencies
- [ ] Terminal renders correctly at 100×35 (manual: `stty cols 100 rows 35 && tsx src/cli/index.ts chat`)

---

## 18. Known Limitations (This Wave)

1. **Tool events are not emitted from the live stream.** `_streamAnthropic` and `_streamOpenAICompat` in `provider.ts` do NOT call `dispatcher.emit`. Tool cards will only appear when `dispatcher.emitDemo()` is called explicitly (useful for testing). Wiring real Anthropic tool-use events is a separate wave.
2. **`@filename` mentions are cosmetic.** The mention text is inserted into the input string and sent to the model as plain text. The model does not receive file content automatically. File-reading on `@mention` is a future wave.
3. **AlwaysAllow list is in-memory.** `alwaysAllowTools` is a `Set<string>` in React state. It does not persist across process restarts.
4. **Banner last-session recap is a placeholder.** `lastSessionSummary` is passed as `null` until a session persistence mechanism is built. The banner renders without the recap line when null.
5. **Ctrl+O expands the last tool card only.** Multi-card expand/collapse per-card is not implemented in this wave.

---

*Spec written: 2026-04-17. Locked. Builder must implement exactly this spec — no divergence.*

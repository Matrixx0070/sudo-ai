import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import { AGENTS } from './constants.js';
import type { AgentCode, AgentRuntime, AgentState } from './types.js';
import './mission-control.css';

// ── Room positions (where agents stand when visiting a room) ─────────────────

const ROOM_POSITIONS: Record<string, { x: number; y: number }> = {
  'workspace':     { x: 360, y: 370 },
  'library':       { x: 975, y: 390 },
  'server-room':   { x: 975, y: 390 },
  'meeting-room':  { x: 960, y: 740 },
  'conference':    { x: 960, y: 740 },
  'frank-office':  { x: 680, y: 600 },
  'break-room':    { x: 350, y: 680 },
  'lobby':         { x: 530, y: 600 },
};

// ── Sprite sheet config ──────────────────────────────────────────────────────

const CHAR_MAP: Record<AgentCode, string> = {
  'SUDO-1': '/pixel/characters/agent_nova.png',
  'SUDO-2': '/pixel/characters/agent_kuro.png',
  'SUDO-3': '/pixel/characters/agent_pixel.png',
  'SUDO-4': '/pixel/characters/agent_bolt.png',
  'SUDO-5': '/pixel/characters/agent_echo.png',
  'SUDO-6': '/pixel/characters/agent_flux.png',
  'SUDO-7': '/pixel/characters/agent_vex.png',
  'SUDO-8': '/pixel/characters/agent_aria.png',
};

// Sprite sheet rows: 0=down(idle), 1=left, 2=right, 3=up
// Row index maps to Y offset: row * 48
const SPRITE_ROW: Record<AgentState, number> = {
  idle: 0, working: 0, thinking: 0, talking: 0, break: 3, walking: 2, error: 0,
};

// ── Default desk positions on 1296x960 canvas ────────────────────────────────
// All y values kept between 200–700 so agents are always on-screen.

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const AGENT_PIXEL_POS: Record<AgentCode, { x: number; y: number }> = {
  'SUDO-1': { x: 280,  y: 360 },  // Nova  — top-left office, main workspace desk
  'SUDO-2': { x: 440,  y: 360 },  // Kuro  — top-left office, main workspace desk
  'SUDO-3': { x: 880,  y: 340 },  // Pixel — top-right, near bookshelves/computers
  'SUDO-4': { x: 1060, y: 380 },  // Bolt  — top-right, near server rack
  'SUDO-5': { x: 320,  y: 700 },  // Echo  — bottom-left, break room furniture
  'SUDO-6': { x: 530,  y: 570 },  // Flux  — center transition/lobby area
  'SUDO-7': { x: 920,  y: 700 },  // Vex   — bottom-right, conference desk
  'SUDO-8': { x: 1040, y: 740 },  // Aria  — bottom-right, conference furniture
};

// Default home room for each agent (used to detect when they've moved away)
const AGENT_HOME_ROOM: Record<AgentCode, string> = {
  'SUDO-1': 'workspace',
  'SUDO-2': 'workspace',
  'SUDO-3': 'library',
  'SUDO-4': 'server-room',
  'SUDO-5': 'break-room',
  'SUDO-6': 'lobby',
  'SUDO-7': 'meeting-room',
  'SUDO-8': 'conference',
};

function getAgentPosition(code: AgentCode, currentRoom?: string): { x: number; y: number } {
  const homeRoom = AGENT_HOME_ROOM[code];
  if (currentRoom && currentRoom !== homeRoom && ROOM_POSITIONS[currentRoom]) {
    return ROOM_POSITIONS[currentRoom];
  }
  return AGENT_PIXEL_POS[code];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function dotColor(s: AgentState): string {
  const map: Record<string, string> = {
    working: '#22c55e', thinking: '#eab308', talking: '#3b82f6',
    idle: '#6b7280', walking: '#14b8a6', break: '#a855f7', error: '#ef4444',
  };
  return map[s] ?? '#6b7280';
}

function stateLabel(s: AgentState): string {
  const map: Record<string, string> = {
    working: 'Working', thinking: 'Thinking', talking: 'Talking',
    idle: 'Idle', walking: 'Moving', break: 'Break', error: 'Error',
  };
  return map[s] ?? s;
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatUptime(s: number): string {
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function eventDot(msg: string): string {
  if (/error|fail/i.test(msg)) return '#ef4444';
  if (/complet|done/i.test(msg)) return '#22c55e';
  if (/think/i.test(msg)) return '#eab308';
  return '#6b7280';
}

// ── Dust Particles ───────────────────────────────────────────────────────────

function DustParticles() {
  const particles = useMemo(() => Array.from({ length: 25 }, (_, i) => ({
    id: i,
    x: Math.floor(Math.random() * 1296),
    y: Math.floor(Math.random() * 960),
    size: 1 + Math.random() * 2.5,
    delay: Math.random() * 15,
    duration: 10 + Math.random() * 20,
    opacity: 0.15 + Math.random() * 0.25,
  })), []);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3, overflow: 'hidden' }} aria-hidden="true">
      {particles.map(p => (
        <div
          key={p.id}
          className="mc-dust"
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            width: p.size,
            height: p.size,
            borderRadius: '50%',
            background: '#fff',
            opacity: p.opacity,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

// ── PixelAgent sub-component ─────────────────────────────────────────────────

interface PixelAgentProps {
  code: AgentCode;
  runtime: AgentRuntime;
  frame: number;
  isSelected: boolean;
  onSelect: (code: AgentCode) => void;
  currentRoom?: string;
}

function PixelAgent({ code, runtime, frame, isSelected, onSelect, currentRoom }: PixelAgentProps) {
  const def = AGENTS.find(a => a.code === code)!;
  const pos = getAgentPosition(code, currentRoom);
  const spriteUrl = CHAR_MAP[code];
  const row = SPRITE_ROW[runtime.state] ?? 0;
  const isTalking = runtime.state === 'talking';
  const isThinking = runtime.state === 'thinking';
  const isError = runtime.state === 'error';
  const isWorking = runtime.state === 'working';

  const glowFilter = isSelected
    ? `drop-shadow(0 0 5px ${def.color}) drop-shadow(0 0 10px ${def.color})`
    : isWorking
    ? `drop-shadow(0 0 3px ${def.color})`
    : isError
    ? 'drop-shadow(0 0 4px #ef4444)'
    : 'none';

  return (
    <div
      onClick={() => onSelect(code)}
      role="button"
      tabIndex={0}
      aria-label={`${def.name}, ${def.role}, ${stateLabel(runtime.state)}`}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(code); }}
      style={{
        position: 'absolute',
        left: pos.x - 48,
        top: pos.y - 90,
        cursor: 'pointer',
        zIndex: Math.floor(pos.y),
        transition: 'left 2s ease-in-out, top 2s ease-in-out',
      }}
    >
      {/* Speech / thought bubble */}
      {(isTalking || isThinking) && (
        <div style={{
          position: 'absolute', bottom: 110, left: '50%', transform: 'translateX(-50%)',
          background: '#fff', borderRadius: 8, padding: '3px 10px',
          fontSize: 13, color: '#1f2937', whiteSpace: 'nowrap',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)', border: '1px solid #e5e7eb',
          pointerEvents: 'none', fontWeight: 600,
        }}>
          {isTalking ? '💬 chatting...' : '💭 thinking...'}
        </div>
      )}

      {/* Glowing circle platform behind agent */}
      <div aria-hidden="true" style={{
        position: 'absolute',
        bottom: 8, left: '50%',
        transform: 'translateX(-50%)',
        width: 56, height: 18,
        borderRadius: '50%',
        background: `radial-gradient(ellipse, ${hexToRgba(def.color, 0.4)} 0%, transparent 70%)`,
        border: `1.5px solid ${hexToRgba(def.color, 0.5)}`,
        boxShadow: `0 0 12px ${hexToRgba(def.color, 0.3)}`,
        zIndex: -1,
      }} />

      {/* Pixel sprite — SCALED 2x for visibility */}
      <div
        className={isError ? 'mc-pixel-shake' : isWorking ? 'mc-pixel-bob' : ''}
        style={{
          width: 48, height: 48,
          backgroundImage: `url(${spriteUrl})`,
          backgroundPosition: `-${frame * 48}px -${row * 48}px`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: 'auto',
          imageRendering: 'pixelated',
          filter: `brightness(1.2) ${glowFilter}`,
          transition: 'filter 0.3s',
          transform: 'scale(2)',
          transformOrigin: 'bottom center',
        }}
      />

      {/* Name tag with background pill */}
      <div style={{
        textAlign: 'center', marginTop: -2,
      }}>
        <span style={{
          display: 'inline-block',
          fontSize: 11, fontWeight: 700,
          color: '#fff',
          background: hexToRgba(def.color, 0.7),
          padding: '1px 8px',
          borderRadius: 6,
          fontFamily: 'Inter, sans-serif',
          letterSpacing: 0.5,
          whiteSpace: 'nowrap',
          boxShadow: `0 0 8px ${hexToRgba(def.color, 0.4)}, 0 1px 3px rgba(0,0,0,0.5)`,
        }}>
          {def.name}
        </span>
      </div>

      {/* Status dot */}
      <div className={isWorking ? 'mc-pulse' : ''} style={{
        position: 'absolute', top: 0, right: 6,
        width: 12, height: 12, borderRadius: '50%',
        background: dotColor(runtime.state),
        border: '2px solid #0a0e1a',
        boxShadow: runtime.state !== 'idle' ? `0 0 6px ${dotColor(runtime.state)}` : 'none',
      }} />

      {/* Working task badge */}
      {isWorking && runtime.currentTask && (
        <div style={{
          position: 'absolute', top: -8, left: 80,
          background: 'rgba(34,197,94,0.9)', borderRadius: 6,
          padding: '2px 8px', fontSize: 9, color: '#fff',
          whiteSpace: 'nowrap', fontWeight: 700,
          boxShadow: '0 0 8px rgba(34,197,94,0.4), 0 2px 4px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
        }}>
          {'\u26a1'} {runtime.currentTask.slice(0, 18)}
        </div>
      )}
    </div>
  );
}

// ── Sidebar agent row ─────────────────────────────────────────────────────────

interface SidebarAgentProps {
  code: AgentCode;
  runtime: AgentRuntime;
  frame: number;
  isSelected: boolean;
  onSelect: (code: AgentCode) => void;
}

function SidebarAgent({ code, runtime, frame, isSelected, onSelect }: SidebarAgentProps) {
  const def = AGENTS.find(a => a.code === code)!;
  const spriteUrl = CHAR_MAP[code];
  const row = SPRITE_ROW[runtime.state] ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${def.name} ${def.role}`}
      aria-selected={isSelected}
      onClick={() => onSelect(code)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(code); }}
      className={`mc-sidebar-agent${isSelected ? ' selected' : ''}`}
      style={{ borderLeftColor: isSelected ? def.color : 'transparent' }}
    >
      {/* Mini sprite */}
      <div style={{
        width: 24, height: 24, flexShrink: 0, overflow: 'hidden',
        position: 'relative',
      }}>
        <div style={{
          width: 48, height: 48,
          backgroundImage: `url(${spriteUrl})`,
          backgroundPosition: `-${frame * 48}px -${row * 48}px`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: 'auto',
          imageRendering: 'pixelated',
          transform: 'scale(0.5)',
          transformOrigin: 'top left',
        }} />
      </div>
      <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#f3f4f6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {def.name}
        </div>
        <div style={{ fontSize: 9, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {def.role}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor(runtime.state), display: 'inline-block' }} />
        <span style={{ fontSize: 8, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600 }}>
          {stateLabel(runtime.state)}
        </span>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function MissionControl(): React.ReactElement {
  const agents      = useOfficeStore(s => s.agents);
  const events      = useOfficeStore(s => s.events);
  const metrics     = useOfficeStore(s => s.metrics);
  const selectedAgent  = useOfficeStore(s => s.selectedAgent);
  const selectAgent    = useOfficeStore(s => s.selectAgent);
  const dramaEnabled   = useOfficeStore(s => s.dramaEnabled);
  const setDramaEnabled = useOfficeStore(s => s.setDramaEnabled);

  // Sprite animation frame (0,1,2 cycling)
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % 3), 500);
    return () => clearInterval(id);
  }, []);

  // Floating panel open/closed state
  const [panelOpen, setPanelOpen] = useState(true);

  // Scale the 1296x960 canvas to FILL the parent section (use max, not min)
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    function resize() {
      const el = containerRef.current?.parentElement;
      if (!el) return;
      const sx = el.clientWidth / 1296;
      const sy = el.clientHeight / 960;
      setScale(Math.max(sx, sy));
    }
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const activeCount = AGENTS.filter(a => {
    const s = agents[a.code]?.state;
    return s && s !== 'idle' && s !== 'break';
  }).length;

  const selectedDef = useMemo(
    () => (selectedAgent ? AGENTS.find(a => a.code === selectedAgent) : null),
    [selectedAgent],
  );
  const selectedRt = selectedAgent ? agents[selectedAgent] : null;

  function handleSelect(code: AgentCode) {
    selectAgent(selectedAgent === code ? null : code);
  }

  return (
    <div
      role="main"
      aria-label="SUDO-AI Crystal Palace"
      style={{
        display: 'flex', flexDirection: 'column',
        height: '100%', width: '100%',
        background: '#0a0e1a', color: '#fff',
        fontFamily: "'Inter', system-ui, sans-serif",
        overflow: 'hidden',
      }}
    >
      {/* Crystal accent line */}
      <div className="mc-crystal-line" aria-hidden="true" />

      {/* ── Header ── */}
      <header style={{
        height: 44, minHeight: 44, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px',
        background: 'linear-gradient(90deg,#0d1117,#111827,#0d1117)',
        borderBottom: '1px solid #1f2937',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 22, height: 22, borderRadius: 4,
            background: 'linear-gradient(135deg,#3b82f6,#a855f7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 12, color: '#fff', flexShrink: 0,
          }}>S</div>
          <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.04em' }}>SUDO-AI</span>
          <span style={{ fontSize: 11, color: '#4b5563' }}>Crystal Palace</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="mc-online" style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} aria-label="Online" />
          <span style={{ fontSize: 11, color: '#22c55e' }}>Online</span>
          {([
            { l: 'CPU', v: metrics.cpu, c: '#60a5fa' },
            { l: 'MEM', v: metrics.memory, c: '#c084fc' },
            { l: 'DSK', v: metrics.disk, c: '#2dd4bf' },
          ] as const).map(p => (
            <span key={p.l} style={{ background: '#151c2c', borderRadius: 4, padding: '2px 7px', fontSize: 10, color: '#6b7280' }}>
              {p.l} <strong style={{ color: p.c }}>{p.v}%</strong>
            </span>
          ))}
          <span style={{ background: '#151c2c', borderRadius: 4, padding: '2px 7px', fontSize: 10, color: '#6b7280' }}>
            <strong style={{ color: '#f9fafb' }}>{activeCount}/8</strong> Active
          </span>
        </div>
      </header>

      {/* ── Body — full-width office with floating overlay panel ── */}
      <section
        aria-label="Office floor plan"
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#060a12' }}
      >
        {/* Scaled world: background + characters — fills the entire section */}
        <div
          ref={containerRef}
          style={{
            width: 1296, height: 960,
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
            position: 'absolute',
            left: '50%', top: '50%',
            marginLeft: -648, marginTop: -480,
          }}
        >
          {/* Pixel art office background */}
          <img
            src="/pixel/office-bg.png"
            alt="Crystal Palace office"
            draggable={false}
            style={{
              position: 'absolute', inset: 0,
              width: 1296, height: 960,
              imageRendering: 'pixelated',
              userSelect: 'none',
              display: 'block',
            }}
          />

          {/* Warm ambient lighting overlay — z:1 */}
          <div aria-hidden="true" style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1,
            background: 'radial-gradient(ellipse at 30% 25%, rgba(255,200,100,0.08) 0%, transparent 60%), radial-gradient(ellipse at 70% 75%, rgba(100,150,255,0.06) 0%, transparent 50%)',
            mixBlendMode: 'screen',
          }} />

          {/* Desk screen glows — z:2 (positions match agent locations) */}
          {([
            { x: 280,  y: 340, color: 'rgba(100,180,255,0.15)', size: 60 },  // Nova
            { x: 440,  y: 340, color: 'rgba(100,180,255,0.15)', size: 60 },  // Kuro
            { x: 880,  y: 320, color: 'rgba(50,255,200,0.10)',  size: 70 },  // Pixel — bookshelves/computers
            { x: 1060, y: 360, color: 'rgba(50,255,100,0.08)',  size: 80 },  // Bolt  — server rack
            { x: 320,  y: 680, color: 'rgba(255,150,100,0.10)', size: 65 },  // Echo  — break room furniture
            { x: 530,  y: 550, color: 'rgba(100,180,255,0.10)', size: 60 },  // Flux  — lobby/transition
            { x: 920,  y: 680, color: 'rgba(255,200,100,0.10)', size: 70 },  // Vex   — conference desk
            { x: 1040, y: 720, color: 'rgba(200,100,255,0.10)', size: 70 },  // Aria  — conference furniture
          ] as const).map((light, i) => (
            <div
              key={`light-${i}`}
              className="mc-light-pulse"
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: light.x - light.size / 2,
                top:  light.y - light.size / 2,
                width:  light.size,
                height: light.size,
                borderRadius: '50%',
                background: `radial-gradient(circle, ${light.color} 0%, transparent 70%)`,
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />
          ))}

          {/* Floating dust particles — z:3 */}
          <DustParticles />

          {/* Vignette — z:4 */}
          <div aria-hidden="true" style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4,
            background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)',
          }} />

          {/* Scanline CRT overlay — z:5 */}
          <div className="mc-scanlines" aria-hidden="true" style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5,
          }} />

          {/* Room labels — subtle floating text for spatial context — z:6 */}
          {([
            { label: 'Workspace',  x: 200,  y: 280 },
            { label: 'Library',    x: 860,  y: 290 },
            { label: 'Break Room', x: 230,  y: 600 },
            { label: 'Lobby',      x: 470,  y: 530 },
            { label: 'Conference', x: 870,  y: 650 },
          ] as const).map(room => (
            <div
              key={room.label}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: room.x,
                top: room.y,
                fontSize: 11,
                fontFamily: "'Inter', system-ui, sans-serif",
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
                color: 'rgba(255,255,255,0.15)',
                fontWeight: 600,
                pointerEvents: 'none',
                userSelect: 'none',
                zIndex: 6,
                whiteSpace: 'nowrap',
              }}
            >
              {room.label}
            </div>
          ))}

          {/* Characters */}
          {AGENTS.map(def => {
            const rt = agents[def.code];
            if (!rt) return null;
            return (
              <PixelAgent
                key={def.code}
                code={def.code}
                runtime={rt}
                frame={frame}
                isSelected={selectedAgent === def.code}
                onSelect={handleSelect}
                currentRoom={rt.currentRoom}
              />
            );
          })}
        </div>

        {/* ── Floating right panel (overlay) ── */}
        <aside
          className="mc-sidebar"
          aria-label="Agent list and events"
          style={{
            position: 'absolute', right: 0, top: 0, bottom: 0,
            width: panelOpen ? 280 : 0,
            background: 'rgba(13, 17, 30, 0.95)',
            backdropFilter: 'blur(8px)',
            borderLeft: '1px solid rgba(99, 102, 241, 0.3)',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
            transition: 'width 0.3s ease',
            zIndex: 500,
          }}
        >
          {/* Agents list */}
          <div style={{ padding: '10px 10px 6px', borderBottom: '1px solid rgba(99,102,241,0.15)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid rgba(99,102,241,0.1)' }}>
              <span style={{ fontSize: 10, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                Agents
              </span>
              <span style={{ background: '#151c2c', borderRadius: 99, padding: '1px 6px', fontSize: 9, color: '#6b7280' }}>
                {activeCount}/8
              </span>
            </div>
            {AGENTS.map(def => {
              const rt = agents[def.code];
              if (!rt) return null;
              return (
                <SidebarAgent
                  key={def.code}
                  code={def.code}
                  runtime={rt}
                  frame={frame}
                  isSelected={selectedAgent === def.code}
                  onSelect={handleSelect}
                />
              );
            })}
          </div>

          {/* Selected agent detail panel */}
          {selectedDef && selectedRt && (
            <div style={{
              padding: 10, borderBottom: '1px solid #1a2030',
              background: 'rgba(59,130,246,0.04)', flexShrink: 0,
            }}>
              <div style={{ fontSize: 10, color: '#4b5563', textTransform: 'uppercase', marginBottom: 4, letterSpacing: '0.08em' }}>
                Selected
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                {/* Larger sprite preview */}
                <div style={{ width: 48, height: 48, overflow: 'hidden', flexShrink: 0, imageRendering: 'pixelated' }}>
                  <div style={{
                    width: 48, height: 48,
                    backgroundImage: `url(${CHAR_MAP[selectedDef.code]})`,
                    backgroundPosition: `-${frame * 48}px 0px`,
                    backgroundRepeat: 'no-repeat',
                    backgroundSize: 'auto',
                    imageRendering: 'pixelated',
                  }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: selectedDef.color }}>{selectedDef.name}</div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>
                    {selectedDef.role} — {stateLabel(selectedRt.state)}
                  </div>
                  {selectedRt.currentTask && (
                    <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 3 }}>
                      {selectedRt.currentTask}
                    </div>
                  )}
                  {selectedRt.state === 'working' && selectedRt.currentTask && (
                    <div
                      role="progressbar"
                      aria-valuenow={selectedRt.taskProgress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      style={{ height: 3, background: '#1a2030', borderRadius: 2, overflow: 'hidden', marginBottom: 3 }}
                    >
                      <div style={{
                        height: '100%', width: `${selectedRt.taskProgress}%`,
                        background: selectedDef.color, borderRadius: 2,
                        transition: 'width 0.4s',
                      }} />
                    </div>
                  )}
                  <div style={{ fontSize: 9, color: '#6b7280' }}>
                    {selectedRt.lastActivity} — {fmt(selectedRt.lastActivityTime)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Event Timeline */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 10px 6px', borderBottom: '1px solid rgba(99,102,241,0.1)', flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }}>
                Events
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 10px' }} aria-live="polite" aria-label="Event timeline">
              {events.length === 0 && (
                <div style={{ fontSize: 10, color: '#6b7280', padding: '6px 0' }}>No events yet...</div>
              )}
              {events.slice(0, 30).map((ev, i) => (
                <div
                  key={ev.id ?? i}
                  style={{
                    padding: '4px 0', borderBottom: '1px solid rgba(26,32,48,0.6)',
                    fontSize: 10, display: 'flex', alignItems: 'flex-start', gap: 5,
                  }}
                >
                  <span style={{
                    width: 4, height: 4, borderRadius: '50%',
                    background: eventDot(ev.message),
                    flexShrink: 0, marginTop: 4,
                  }} />
                  <div>
                    <span style={{ color: '#6b7280', marginRight: 4, fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(ev.timestamp)}
                    </span>
                    <span style={{ color: '#d1d5db' }}>{ev.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Panel toggle button — floats at the left edge of the panel */}
        <button
          type="button"
          onClick={() => setPanelOpen(o => !o)}
          aria-expanded={panelOpen}
          aria-label={panelOpen ? 'Collapse agent panel' : 'Expand agent panel'}
          style={{
            position: 'absolute',
            right: panelOpen ? 280 : 0,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 501,
            width: 24, height: 60,
            background: 'rgba(10,14,26,0.85)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRight: 'none',
            borderRadius: '8px 0 0 8px',
            color: '#9ca3af',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
            transition: 'right 0.3s ease',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {panelOpen ? '\u203a' : '\u2039'}
        </button>
      </section>

      {/* ── Footer ── */}
      <footer
        role="contentinfo"
        style={{
          height: 30, minHeight: 30, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 16px',
          background: '#0d1117', borderTop: '1px solid #1a2030',
          fontSize: 10, color: '#4b5563',
        }}
      >
        <div style={{ display: 'flex', gap: 12 }}>
          <span>CPU <strong style={{ color: '#60a5fa' }}>{metrics.cpu}%</strong></span>
          <span>MEM <strong style={{ color: '#c084fc' }}>{metrics.memory}%</strong></span>
          <span>DISK <strong style={{ color: '#2dd4bf' }}>{metrics.disk}%</strong></span>
        </div>
        <div>UP <strong style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{formatUptime(metrics.uptime)}</strong></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span><strong style={{ color: '#e5e7eb' }}>{activeCount}/8</strong> Active</span>
          <button
            type="button"
            onClick={() => setDramaEnabled(!dramaEnabled)}
            aria-pressed={dramaEnabled}
            aria-label="Toggle drama engine"
            style={{
              background: 'none',
              border: `1px solid ${dramaEnabled ? '#16a34a' : '#374151'}`,
              borderRadius: 3, cursor: 'pointer', padding: '1px 7px',
              fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em',
              color: dramaEnabled ? '#4ade80' : '#4b5563',
              transition: 'color 0.2s, border-color 0.2s',
            }}
          >
            Drama {dramaEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </footer>
    </div>
  );
}

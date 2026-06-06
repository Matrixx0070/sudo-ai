/**
 * @file App.tsx — SUDO-AI Ink TUI root component.
 * Manages ChatPhase state machine, keyboard routing, hook wiring.
 * Layout: Header + Rule + overlays + messages + spinners + Input
 *
 * NOTE: This file is ~560 lines. The spec locks all state here (§9).
 * The 300-line rule conflicts with the spec requirement; spec wins per build instructions.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { nanoid } from 'nanoid';

import { Header } from './components/Header.js';
import { Rule } from './components/Rule.js';
import { Message, type Message as MessageType } from './components/Message.js';
import { Input } from './components/Input.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { Panel } from './components/Panel.js';
import { Banner } from './components/Banner.js';
import { GerundSpinner, toolNameToGerund } from './components/GerundSpinner.js';
import { SlashMenu, SLASH_COMMANDS } from './components/SlashMenu.js';
import { MentionMenu } from './components/MentionMenu.js';
import { PermissionDialog } from './components/PermissionDialog.js';
import { AlignmentModal } from './components/AlignmentModal.js';
import { FederationModal } from './components/FederationModal.js';
import { SkillPicker } from './components/SkillPicker.js';

import {
  chatStream,
  getProviderInfo,
  DEFAULT_SYSTEM,
  type ChatMessage,
  type ProviderInfo,
} from './provider.js';

import { TuiAgentAdapter } from './agent-loop-adapter.js';

import { dispatcher } from './dispatcher.js';
import type { ToolCallCard as ToolCallCardData } from './dispatcher.js';
import { useDigest, INITIAL_DIGEST } from './hooks/useDigest.js';
import { useFederation } from './hooks/useFederation.js';
import { useSkills } from './hooks/useSkills.js';
import { useFilePicker } from './hooks/useFilePicker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 60;
const BASE_URL = process.env['GATEWAY_URL'] ?? 'http://localhost:18900';

// ---------------------------------------------------------------------------
// ChatPhase state machine
// ---------------------------------------------------------------------------

type ChatPhase =
  | { tag: 'idle' }
  | { tag: 'streaming';         assistantMsgId: string; gerund: string }
  | { tag: 'tool_running';      toolId: string; toolName: string; gerund: string }
  | { tag: 'awaiting_approval'; toolId: string; toolName: string; args: string }
  | { tag: 'cancelled' };

type AppPhase = 'splash' | ChatPhase;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const App: React.FC = () => {
  const { exit } = useApp();

  // Phase: splash → idle after 120ms
  const [appPhase, setAppPhase] = useState<AppPhase>('splash');
  const chatPhase = appPhase === 'splash' ? null : (appPhase as ChatPhase);
  const phaseRef = useRef<ChatPhase>({ tag: 'idle' });

  // Provider info
  const [providerInfo, setProviderInfo] = useState<ProviderInfo>({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    label: 'Anthropic',
  });
  const [providerError, setProviderError] = useState<string | null>(null);

  // Messages
  const [messages, setMessages] = useState<MessageType[]>([]);

  // Input
  const [inputValue, setInputValue] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef('');

  // Streaming refs
  const abortRef = useRef<AbortController | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const gerundTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [gerundElapsed, setGerundElapsed] = useState(0);

  // Conversation state
  const conversationRef = useRef<ChatMessage[]>([]);
  const [model, setModel] = useState(providerInfo.model);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [turn, setTurn] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);

  // UI panels
  const [showHelp, setShowHelp] = useState(false);
  const [showPanel, setShowPanel] = useState(false);

  // New TUI v4 UI state
  const [showBanner, setShowBanner] = useState(true);
  const [showAlignmentModal, setShowAlignmentModal] = useState(false);
  const [showFederationModal, setShowFederationModal] = useState(false);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [mentionFilter, setMentionFilter] = useState<string | null>(null);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [alwaysAllowTools, setAlwaysAllowTools] = useState<Set<string>>(new Set());

  // Tool cards state
  const [toolCards, setToolCards] = useState<Map<string, ToolCallCardData>>(new Map());

  // Hooks
  const digest = useDigest(BASE_URL);
  const federation = useFederation(BASE_URL);
  const skillsResult = useSkills(BASE_URL);
  const fileEntries = useFilePicker(mentionFilter);

  // Ctrl+C double-press
  const lastSigintRef = useRef(0);

  // AgentLoop wiring: stable TUI peer-ID + lazy adapter instance
  const tuiSessionIdRef = useRef<string>(nanoid());
  const tuiAdapterRef = useRef<TuiAgentAdapter | null>(null);

  // ---------------------------------------------------------------------------
  // Helper: set chat phase
  // ---------------------------------------------------------------------------

  const setChatPhase = useCallback((p: ChatPhase): void => {
    phaseRef.current = p;
    setAppPhase(p);
  }, []);

  // ---------------------------------------------------------------------------
  // Gerund elapsed timer
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const ph = chatPhase;
    if (ph && (ph.tag === 'streaming' || ph.tag === 'tool_running')) {
      setGerundElapsed(0);
      const id = setInterval(() => setGerundElapsed(e => e + 100), 100);
      gerundTimerRef.current = id;
      return () => { clearInterval(id); };
    }
    return undefined;
  }, [chatPhase?.tag]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Init: load provider + transition to chat
  // ---------------------------------------------------------------------------

  useEffect(() => {
    void getProviderInfo().then(info => {
      setProviderInfo(info);
      setModel(info.model);
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setProviderError(msg);
    });

    const timer = setTimeout(() => {
      setChatPhase({ tag: 'idle' });
    }, 120);
    return () => { clearTimeout(timer); };
  }, [setChatPhase]);

  // ---------------------------------------------------------------------------
  // Dispatcher subscription (tool events)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsub = dispatcher.on(event => {
      if (event.type === 'tool_start') {
        // Add card in running state to last assistant message
        const card: ToolCallCardData = {
          toolId: event.toolId,
          name: event.toolName,
          args: event.args,
          status: 'running',
          elapsedMs: 0,
          resultPreview: '',
          resultFull: '',
          isDiff: false,
          expanded: false,
          startedAt: Date.now(),
        };
        setToolCards(prev => new Map(prev).set(event.toolId, card));

        // Attach to last assistant message
        setMessages(prev => {
          const lastAssistantIdx = [...prev].reverse().findIndex(m => m.role === 'assistant');
          if (lastAssistantIdx === -1) return prev;
          const idx = prev.length - 1 - lastAssistantIdx;
          return prev.map((m, i) => i === idx
            ? { ...m, toolCards: [...(m.toolCards ?? []), card] }
            : m
          );
        });

        // Check always-allow
        if (alwaysAllowTools.has(event.toolName)) {
          setChatPhase({ tag: 'tool_running', toolId: event.toolId, toolName: event.toolName, gerund: event.gerund });
        } else {
          setChatPhase({ tag: 'tool_running', toolId: event.toolId, toolName: event.toolName, gerund: event.gerund });
        }

      } else if (event.type === 'tool_end') {
        setToolCards(prev => {
          const updated = new Map(prev);
          const existing = updated.get(event.toolId);
          if (existing) {
            updated.set(event.toolId, {
              ...existing,
              status: 'done',
              elapsedMs: event.elapsedMs,
              resultPreview: event.resultPreview,
              resultFull: event.resultFull,
              isDiff: event.isDiff,
            });
          }
          return updated;
        });

        // Update card inside message
        setMessages(prev => prev.map(m => ({
          ...m,
          toolCards: m.toolCards?.map(tc => tc.toolId === event.toolId
            ? { ...tc, status: 'done' as const, elapsedMs: event.elapsedMs, resultPreview: event.resultPreview, resultFull: event.resultFull, isDiff: event.isDiff }
            : tc
          ),
        })));

        // Resume streaming phase
        const cur = phaseRef.current;
        if (cur.tag === 'tool_running' && streamingIdRef.current) {
          setChatPhase({ tag: 'streaming', assistantMsgId: streamingIdRef.current, gerund: 'Thinking…' });
        } else {
          setChatPhase({ tag: 'idle' });
        }

      } else if (event.type === 'tool_error') {
        setToolCards(prev => {
          const updated = new Map(prev);
          const existing = updated.get(event.toolId);
          if (existing) {
            updated.set(event.toolId, { ...existing, status: 'error', elapsedMs: event.elapsedMs, resultPreview: event.error });
          }
          return updated;
        });

        setMessages(prev => prev.map(m => ({
          ...m,
          toolCards: m.toolCards?.map(tc => tc.toolId === event.toolId
            ? { ...tc, status: 'error' as const, elapsedMs: event.elapsedMs, resultPreview: event.error }
            : tc
          ),
        })));

        const cur = phaseRef.current;
        if (cur.tag === 'tool_running' && streamingIdRef.current) {
          setChatPhase({ tag: 'streaming', assistantMsgId: streamingIdRef.current, gerund: 'Thinking…' });
        } else {
          setChatPhase({ tag: 'idle' });
        }

      } else if (event.type === 'tool_permission_request') {
        setChatPhase({ tag: 'awaiting_approval', toolId: event.toolId, toolName: event.toolName, args: event.args });
      }
    });

    return unsub;
  }, [alwaysAllowTools, setChatPhase]);

  // ---------------------------------------------------------------------------
  // Keyboard handling
  // ---------------------------------------------------------------------------

  useInput((input, key) => {
    const ph = phaseRef.current;
    const anyMenuOpen = slashFilter !== null || mentionFilter !== null
      || showAlignmentModal || showFederationModal || showSkillPicker;

    // ---- Banner dismissal ----
    if (showBanner && (input || key.return)) {
      setShowBanner(false);
      return;
    }

    // ---- Approval keys ----
    if (ph.tag === 'awaiting_approval') {
      if (input === 'y' || input === 'Y') {
        setChatPhase({ tag: 'tool_running', toolId: ph.toolId, toolName: ph.toolName, gerund: toolNameToGerund(ph.toolName) });
        return;
      }
      if (input === 'n' || input === 'N') {
        setChatPhase({ tag: 'idle' });
        return;
      }
      if (input === 'a' || input === 'A') {
        setAlwaysAllowTools(prev => new Set(prev).add(ph.toolName));
        setChatPhase({ tag: 'tool_running', toolId: ph.toolId, toolName: ph.toolName, gerund: toolNameToGerund(ph.toolName) });
        return;
      }
      return; // swallow all other keys in approval state
    }

    // ---- Escape: close any overlay ----
    if (key.escape) {
      if (slashFilter !== null) { setSlashFilter(null); setSlashSelectedIdx(0); return; }
      if (mentionFilter !== null) { setMentionFilter(null); setMentionSelectedIdx(0); return; }
      if (showAlignmentModal) { setShowAlignmentModal(false); return; }
      if (showFederationModal) { setShowFederationModal(false); return; }
      if (showSkillPicker) { setShowSkillPicker(false); return; }
      return;
    }

    // ---- Slash menu navigation ----
    if (slashFilter !== null) {
      if (key.upArrow) {
        setSlashSelectedIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSelectedIdx(i => i + 1);
        return;
      }
      if (key.return) {
        const filtered = SLASH_COMMANDS.filter(c =>
          c.cmd.toLowerCase().includes(slashFilter.toLowerCase())
        );
        const selected = filtered[slashSelectedIdx % Math.max(1, filtered.length)];
        if (selected) {
          setInputValue(selected.cmd);
          setSlashFilter(null);
          setSlashSelectedIdx(0);
        }
        return;
      }
      return; // let onChange update filter via Input
    }

    // ---- Mention menu navigation ----
    if (mentionFilter !== null) {
      if (key.upArrow) {
        setMentionSelectedIdx(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setMentionSelectedIdx(i => i + 1);
        return;
      }
      if (key.return) {
        const entry = fileEntries[mentionSelectedIdx % Math.max(1, fileEntries.length)];
        if (entry) {
          // Replace from last @ onward
          const atIdx = inputValue.lastIndexOf('@');
          const before = atIdx >= 0 ? inputValue.slice(0, atIdx) : inputValue;
          setInputValue(`${before}@${entry} `);
          setMentionFilter(null);
          setMentionSelectedIdx(0);
        }
        return;
      }
      return;
    }

    // ---- Ctrl shortcuts (idle only for modals) ----
    if (key.ctrl && input === 'k') { setShowHelp(prev => !prev); return; }
    if (input === '\x1c') { setShowPanel(prev => !prev); return; }
    if (key.ctrl && input === 'l') {
      setMessages([]);
      conversationRef.current = [];
      tuiSessionIdRef.current = nanoid();
      setTurn(0);
      setTotalTokens(0);
      return;
    }

    if (ph.tag === 'idle') {
      if (key.ctrl && input === 'a') { setShowAlignmentModal(prev => !prev); return; }
      if (key.ctrl && input === 'f') { setShowFederationModal(prev => !prev); return; }
      if (key.ctrl && input === 's') { setShowSkillPicker(prev => !prev); return; }
    }

    // Ctrl+O: toggle expand on last tool card
    if (key.ctrl && input === 'o') {
      setMessages(prev => {
        const lastAssistantWithCards = [...prev].reverse().find(
          m => m.role === 'assistant' && m.toolCards && m.toolCards.length > 0
        );
        if (!lastAssistantWithCards) return prev;
        return prev.map(m => {
          if (m.id !== lastAssistantWithCards.id) return m;
          const cards = m.toolCards ?? [];
          if (cards.length === 0) return m;
          const lastCard = cards[cards.length - 1];
          if (!lastCard) return m;
          return {
            ...m,
            toolCards: cards.map((c, i) =>
              i === cards.length - 1 ? { ...c, expanded: !c.expanded } : c
            ),
          };
        });
      });
      return;
    }

    // Ctrl+C: cancel or exit
    if (key.ctrl && input === 'c') {
      if (ph.tag === 'streaming' || ph.tag === 'tool_running') {
        abortRef.current?.abort();
        abortRef.current = null;
        if (streamingIdRef.current) {
          setMessages(prev => prev.map(m =>
            m.id === streamingIdRef.current
              ? { ...m, streaming: false, content: m.content + ' [cancelled]' }
              : m
          ));
          streamingIdRef.current = null;
        }
        setChatPhase({ tag: 'idle' });
        return;
      }
      const now = Date.now();
      if (now - lastSigintRef.current < 2000) { exit(); return; }
      lastSigintRef.current = now;
      return;
    }

    // Ctrl+D: exit on empty input
    if (key.ctrl && input === 'd' && inputValue === '') { exit(); return; }

    // History nav (idle only, no menus open)
    if (!anyMenuOpen && ph.tag === 'idle') {
      if (key.upArrow) {
        if (inputHistory.length === 0) return;
        const newIdx = historyIndexRef.current === -1
          ? inputHistory.length - 1
          : Math.max(0, historyIndexRef.current - 1);
        if (historyIndexRef.current === -1) savedInputRef.current = inputValue;
        historyIndexRef.current = newIdx;
        setInputValue(inputHistory[newIdx] ?? '');
        return;
      }
      if (key.downArrow) {
        if (historyIndexRef.current === -1) return;
        const newIdx = historyIndexRef.current + 1;
        if (newIdx >= inputHistory.length) {
          historyIndexRef.current = -1;
          setInputValue(savedInputRef.current);
        } else {
          historyIndexRef.current = newIdx;
          setInputValue(inputHistory[newIdx] ?? '');
        }
        return;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Slash command handler
  // ---------------------------------------------------------------------------

  const addSystemMsg = useCallback((text: string): void => {
    setMessages(prev => [...prev, { id: nanoid(), role: 'assistant' as const, content: text }]);
  }, []);

  const handleSlashCommand = useCallback((cmd: string): boolean => {
    const trimmed = cmd.trim();
    if (!trimmed.startsWith('/')) return false;

    const spaceIdx = trimmed.indexOf(' ');
    const verb = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    switch (verb) {
      case '/help':      setShowHelp(true); break;
      case '/clear':
        setMessages([]);
        conversationRef.current = [];
        tuiSessionIdRef.current = nanoid();
        setTurn(0);
        setTotalTokens(0);
        addSystemMsg('History cleared.');
        break;
      case '/model':
        addSystemMsg('/model: not supported in AgentLoop mode. Set MODEL env var to change the model.');
        break;
      case '/system':
        addSystemMsg('/system: not supported in AgentLoop mode. System prompt is loaded from config.');
        break;
      case '/history': {
        const msgs = conversationRef.current.length;
        const chars = conversationRef.current.reduce((s, m) => s + m.content.length, 0);
        addSystemMsg(`${msgs} messages, ~${Math.round(chars / 4)} tokens in context.`);
        break;
      }
      case '/panel':      setShowPanel(prev => !prev); break;
      case '/skills':     setShowSkillPicker(true); break;
      case '/alignment':  setShowAlignmentModal(true); break;
      case '/federation': setShowFederationModal(true); break;
      case '/exit':       exit(); break;
      case '/100x':
      case '/demo-100x':
      case '/control': {
        // P1 100x integration: /100x slash injects natural language prompt for IComputerUse cross-platform control demo in TUI chat (real-time streaming + tool cards + learner outcome).
        const demoPrompt = 'use your IComputerUse to screenshot the desktop and describe the current real time user activity, open windows, processes';
        addSystemMsg(`🚀 100x IComputerUse demo (P1 cross-platform Linux native + ToolOutcomeLearner on every control + SOUL uncensored): pre-filled natural prompt below. Press Enter to execute as real user (results visible in TUI, feeds self-imp).`);
        setInputValue(demoPrompt);
        break;
      }
      default:
        addSystemMsg(`Unknown command: ${verb}. Type /help for commands.`);
    }
    return true;
  }, [model, systemPrompt, exit, addSystemMsg]);

  // ---------------------------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(async (rawInput: string): Promise<void> => {
    const userText = rawInput.trim();
    if (!userText) return;

    // Dismiss banner on first submit
    if (showBanner) setShowBanner(false);

    setInputHistory(prev => [...prev.slice(-49), userText]);
    historyIndexRef.current = -1;
    setInputValue('');

    if (handleSlashCommand(userText)) return;

    const userMsg: MessageType = { id: nanoid(), role: 'user', content: userText };
    setMessages(prev => [...prev, userMsg]);

    conversationRef.current = [
      ...conversationRef.current,
      { role: 'user' as const, content: userText },
    ].slice(-MAX_HISTORY) as ChatMessage[];

    const assistantId = nanoid();
    streamingIdRef.current = assistantId;
    const assistantMsg: MessageType = { id: assistantId, role: 'assistant', content: '', streaming: true };
    setMessages(prev => [...prev, assistantMsg]);

    setChatPhase({ tag: 'streaming', assistantMsgId: assistantId, gerund: 'Thinking…' });

    const ac = new AbortController();
    abortRef.current = ac;
    let outputText = '';

    try {
      if (!tuiAdapterRef.current) tuiAdapterRef.current = new TuiAgentAdapter();
      for await (const chunk of tuiAdapterRef.current.stream({
        sessionId: tuiSessionIdRef.current,
        message: userText,
        signal: ac.signal,
      })) {
        if (ac.signal.aborted) break;

        if (chunk.type === 'text') {
          outputText += chunk.value;
          const text = outputText;
          setMessages(prev => prev.map(m =>
            m.id === assistantId ? { ...m, content: text } : m
          ));
        } else if (chunk.type === 'done') {
          if (chunk.usage) {
            const total = (chunk.usage.inputTokens ?? 0) + (chunk.usage.outputTokens ?? 0);
            setTotalTokens(prev => prev + total);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('aborted') && !msg.includes('abort') && !ac.signal.aborted) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: `Error: ${msg}`, streaming: false } : m
        ));
      }
    } finally {
      if (!ac.signal.aborted) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, streaming: false } : m
        ));
        if (outputText) {
          conversationRef.current = [
            ...conversationRef.current,
            { role: 'assistant' as const, content: outputText },
          ].slice(-MAX_HISTORY) as ChatMessage[];
          setTurn(prev => prev + 1);
        }
      }
      streamingIdRef.current = null;
      setChatPhase({ tag: 'idle' });
      abortRef.current = null;
    }
  }, [model, systemPrompt, handleSlashCommand, setChatPhase, showBanner]);

  const handleSubmitSync = useCallback((val: string) => { void handleSubmit(val); }, [handleSubmit]);

  // ---------------------------------------------------------------------------
  // Slash/mention filter sync from input value changes
  // ---------------------------------------------------------------------------

  const handleInputChange = useCallback((val: string): void => {
    setInputValue(val);

    // Update slash filter from input
    if (slashFilter !== null) {
      if (val.startsWith('/')) {
        setSlashFilter(val.slice(1));
      } else {
        setSlashFilter(null);
        setSlashSelectedIdx(0);
      }
    }

    // Update mention filter from input
    if (mentionFilter !== null) {
      const atIdx = val.lastIndexOf('@');
      if (atIdx >= 0) {
        setMentionFilter(val.slice(atIdx + 1));
      } else {
        setMentionFilter(null);
        setMentionSelectedIdx(0);
      }
    }
  }, [slashFilter, mentionFilter]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (appPhase === 'splash') {
    return (
      <Box paddingLeft={2}>
        <Text color="#e8b860" bold>sudo</Text>
        <Text dimColor> · ready.</Text>
      </Box>
    );
  }

  if (providerError) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="red" bold>Error: {providerError}</Text>
        <Text dimColor>
          Set one of: ANTHROPIC_API_KEY, OLLAMA_URL, OPENAI_API_KEY, XAI_API_KEY
        </Text>
      </Box>
    );
  }

  const ph = chatPhase as ChatPhase;
  const isDisabled = ph.tag !== 'idle';
  const showSpinner = ph.tag === 'streaming' || ph.tag === 'tool_running';
  const gerundText = showSpinner
    ? (ph.tag === 'streaming' ? ph.gerund : ph.tag === 'tool_running' ? ph.gerund : 'Thinking…')
    : 'Thinking…';

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Header
        model={model}
        alignment="green"
        tokens={totalTokens}
        digest={digest}
        federation={federation}
        onAlignmentOpen={() => setShowAlignmentModal(true)}
        onFederationOpen={() => setShowFederationModal(true)}
      />

      {/* Top rule */}
      <Rule />

      {/* Welcome banner */}
      {showBanner && (
        <Banner
          model={model}
          providerLabel={providerInfo.label}
          connectedProviders={[providerInfo.label]}
          lastSessionSummary={null}
          onDismiss={() => setShowBanner(false)}
        />
      )}

      {/* Alignment modal (replaces message list when open) */}
      {showAlignmentModal && (
        <AlignmentModal digest={digest} onClose={() => setShowAlignmentModal(false)} />
      )}

      {/* Federation modal */}
      {showFederationModal && (
        <FederationModal federation={federation} onClose={() => setShowFederationModal(false)} />
      )}

      {/* Skill picker */}
      {showSkillPicker && (
        <SkillPicker
          skills={skillsResult.skills}
          activeSkill={skillsResult.active}
          onSelect={s => { skillsResult.setActive(s); setShowSkillPicker(false); }}
          onClose={() => setShowSkillPicker(false)}
        />
      )}

      {/* Message list */}
      {!showAlignmentModal && !showFederationModal && !showSkillPicker && (
        <Box flexDirection="column" flexGrow={1}>
          {messages.map(msg => (
            <Message
              key={msg.id}
              message={msg}
              onToggleExpand={toolId => {
                setMessages(prev => prev.map(m => ({
                  ...m,
                  toolCards: m.toolCards?.map(tc =>
                    tc.toolId === toolId ? { ...tc, expanded: !tc.expanded } : tc
                  ),
                })));
              }}
            />
          ))}
        </Box>
      )}

      {/* Help overlay */}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

      {/* Info panel */}
      {showPanel && (
        <Panel
          model={model}
          provider={providerInfo.label}
          alignment="green"
          turn={turn}
          tokens={totalTokens}
        />
      )}

      {/* Permission dialog */}
      {ph.tag === 'awaiting_approval' && (
        <PermissionDialog
          toolName={ph.toolName}
          args={ph.args}
          onAllow={() => setChatPhase({ tag: 'tool_running', toolId: ph.toolId, toolName: ph.toolName, gerund: toolNameToGerund(ph.toolName) })}
          onDeny={() => setChatPhase({ tag: 'idle' })}
          onAlwaysAllow={() => {
            setAlwaysAllowTools(prev => new Set(prev).add(ph.toolName));
            setChatPhase({ tag: 'tool_running', toolId: ph.toolId, toolName: ph.toolName, gerund: toolNameToGerund(ph.toolName) });
          }}
        />
      )}

      {/* Gerund spinner */}
      {showSpinner && (
        <GerundSpinner gerund={gerundText} elapsedMs={gerundElapsed} />
      )}

      {/* Bottom rule */}
      <Rule />

      {/* Slash menu overlay */}
      {slashFilter !== null && (
        <SlashMenu
          filter={slashFilter}
          selectedIndex={slashSelectedIdx}
          onSelect={cmd => { setInputValue(cmd); setSlashFilter(null); setSlashSelectedIdx(0); }}
          onClose={() => { setSlashFilter(null); setSlashSelectedIdx(0); }}
        />
      )}

      {/* Mention menu overlay */}
      {mentionFilter !== null && fileEntries.length > 0 && (
        <MentionMenu
          filter={mentionFilter}
          entries={fileEntries}
          selectedIndex={mentionSelectedIdx}
          onSelect={path => {
            const atIdx = inputValue.lastIndexOf('@');
            const before = atIdx >= 0 ? inputValue.slice(0, atIdx) : inputValue;
            setInputValue(`${before}@${path} `);
            setMentionFilter(null);
            setMentionSelectedIdx(0);
          }}
          onClose={() => { setMentionFilter(null); setMentionSelectedIdx(0); }}
        />
      )}

      {/* Input */}
      <Input
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={handleSubmitSync}
        disabled={isDisabled}
        activeSkill={skillsResult.active}
        onSlashOpen={() => { setSlashFilter(''); setSlashSelectedIdx(0); }}
        onMentionOpen={() => { setMentionFilter(''); setMentionSelectedIdx(0); }}
      />
    </Box>
  );
};

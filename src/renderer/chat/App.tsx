import React from 'react';
import { useChatSession } from './hooks/useChatSession';
import { useWebSocket } from './hooks/useWebSocket';
import { ConnectionStatus } from './components/ConnectionStatus';
import { ChatWindow } from './components/ChatWindow';
import { InputArea } from './components/InputArea';

export function App() {
  const { messages, currentResponse, error, addMessage, setCurrentResponse, setError } = useChatSession();
  const { connected, sendMessage } = useWebSocket({
    onMessage: (data) => {
      if (data.type === 'thinking') {
        setCurrentResponse({ type: 'thinking', text: data.text || 'Thinking...' });
      } else if (data.type === 'progress') {
        setCurrentResponse({ type: 'progress', text: data.text, progress: data.progress });
      } else if (data.type === 'user_echo') {
        addMessage({ role: 'user', content: data.text, timestamp: new Date() });
        setCurrentResponse({ type: 'thinking', text: 'Thinking...' });
      } else if (data.type === 'reply') {
        const content = 'content' in data ? data.content : (data as { text?: string }).text || '';
        addMessage({ role: 'ai', content, timestamp: new Date() });
        setCurrentResponse(null);
      } else if (data.type === 'error') {
        setError(data.error);
        setCurrentResponse(null);
      }
    },
    onDisconnect: () => {
      setCurrentResponse(null);
    },
  });

  const handleSend = (text: string) => {
    if (!connected) return;
    sendMessage(text);
  };

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      <header className="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
        <div className="w-9 h-9 rounded-lg bg-blue-500/20 flex items-center justify-center font-bold text-lg text-blue-400">
          S
        </div>
        <div>
          <h1 className="text-sm font-semibold">SUDO-AI</h1>
          <p className="text-xs text-gray-400">Digital Life Form v5</p>
        </div>
        <ConnectionStatus connected={connected} />
      </header>

      <ChatWindow messages={messages} currentResponse={currentResponse} error={error} />

      <div className="p-4 border-t border-gray-700">
        <InputArea onSend={handleSend} disabled={!connected} />
      </div>
    </div>
  );
}

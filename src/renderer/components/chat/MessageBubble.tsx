import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolCallCard } from './ToolCallCard';
import { StreamingText } from './StreamingText';
import type { ChatMessage } from '@renderer/stores/chatStore';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({ message, isStreaming = false }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <article
      aria-label={`${message.role} message`}
      className={['flex gap-3 animate-fade-in', isUser ? 'flex-row-reverse' : 'flex-row'].join(' ')}
    >
      {/* Avatar */}
      <div
        aria-hidden="true"
        className={[
          'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5',
          isUser
            ? 'bg-[var(--accent)] text-white'
            : 'bg-[var(--bg-card)] border border-[var(--border)] text-[var(--accent-green)]',
        ].join(' ')}
      >
        {isUser ? 'U' : 'S'}
      </div>

      {/* Bubble */}
      <div className={['max-w-[75%] flex flex-col gap-1', isUser ? 'items-end' : 'items-start'].join(' ')}>
        <div
          className={[
            'px-3 py-2.5 rounded-xl text-sm leading-relaxed',
            isUser
              ? 'bg-[var(--accent)] text-white rounded-tr-sm'
              : 'bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border)] rounded-tl-sm',
          ].join(' ')}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none">
              {isStreaming ? (
                <StreamingText text={message.content} isStreaming={isStreaming} />
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }) {
                      const isBlock = className?.startsWith('language-');
                      return isBlock ? (
                        <pre className="bg-[var(--bg-primary)] rounded-md p-3 overflow-x-auto text-xs">
                          <code {...props}>{children}</code>
                        </pre>
                      ) : (
                        <code
                          className="bg-[var(--bg-primary)] px-1 py-0.5 rounded text-xs text-[var(--accent)]"
                          {...props}
                        >
                          {children}
                        </code>
                      );
                    },
                    a({ href, children }) {
                      return (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--accent)] underline"
                        >
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              )}
            </div>
          )}
        </div>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="w-full space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Timestamp */}
        <time
          dateTime={new Date(message.timestamp).toISOString()}
          className="text-[10px] text-[var(--text-secondary)] px-1"
        >
          {formatTime(message.timestamp)}
        </time>
      </div>
    </article>
  );
}

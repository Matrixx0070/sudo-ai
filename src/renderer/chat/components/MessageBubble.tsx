import React from 'react';
import ReactMarkdown from 'react-markdown';

interface MessageBubbleProps {
  role: 'user' | 'ai';
  content: string;
  timestamp: Date;
}

export function MessageBubble({ role, content, timestamp }: MessageBubbleProps) {
  const time = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`flex gap-2.5 animation-fade-in ${role === 'user' ? 'flex-row-reverse' : ''}`}>
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-xs font-bold ${
          role === 'user'
            ? 'bg-blue-500 text-white'
            : 'bg-gray-700 border border-gray-600 text-emerald-400'
        }`}
      >
        {role === 'user' ? 'U' : 'S'}
      </div>
      <div className={`max-w-[75%] flex flex-col gap-1 ${role === 'user' ? 'items-end' : ''}`}>
        <div
          className={`px-3.5 py-2.5 rounded-[14px] text-sm leading-relaxed whitespace-pre-wrap break-words ${
            role === 'user'
              ? 'bg-blue-500 text-white rounded-tr-sm'
              : 'bg-gray-700 border border-gray-600 rounded-tl-sm'
          }`}
        >
          {role === 'ai' ? (
            <ReactMarkdown
              components={{
                code({ node, className, children, ...props }) {
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                pre({ children }) {
                  return (
                    <pre className="bg-gray-900 rounded-lg p-3 overflow-x-auto text-xs my-2">
                      {children}
                    </pre>
                  );
                },
              }}
            >
              {content}
            </ReactMarkdown>
          ) : (
            content
          )}
        </div>
        <span className="text-[10px] text-gray-400 px-1">{time}</span>
      </div>
    </div>
  );
}

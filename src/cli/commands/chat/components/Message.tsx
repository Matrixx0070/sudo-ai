/**
 * @file Message.tsx — Role label + body + tool call cards.
 * Renders user messages with wrapText, assistant messages with renderMarkdown.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown, wrapText } from '../markdown.js';
import { ToolCallCard } from './ToolCallCard.js';
import type { ToolCallCard as ToolCallCardData } from '../dispatcher.js';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  toolCards?: ToolCallCardData[];
}

// Keep legacy ToolCall interface for backwards compatibility
export interface ToolCall {
  name: string;
  args: string;
  latencyMs: number;
}

interface Props {
  message: Message;
  onToggleExpand: (toolId: string) => void;
}

export const Message: React.FC<Props> = ({ message, onToggleExpand }) => {
  const isUser = message.role === 'user';

  // Render body
  const isWaiting = message.streaming === true && message.content.length === 0;
  let body: string;
  if (isUser) {
    body = wrapText(message.content);
  } else if (isWaiting) {
    body = '';
  } else {
    body = renderMarkdown(message.content);
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Role label */}
      <Box paddingLeft={2}>
        {isUser ? (
          <Text dimColor>you</Text>
        ) : (
          <Text color="#e8b860" bold>sudo</Text>
        )}
        {isWaiting && (
          <Text dimColor> …</Text>
        )}
      </Box>

      {/* Body text */}
      {!isWaiting && body.length > 0 && (
        <Box>
          <Text>{body}</Text>
        </Box>
      )}

      {/* Tool call cards */}
      {message.toolCards && message.toolCards.length > 0 && (
        <Box flexDirection="column">
          {message.toolCards.map(card => (
            <ToolCallCard
              key={card.toolId}
              card={card}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </Box>
      )}
    </Box>
  );
};

/** @file ToolCallCard.tsx — Tool invocation card with status ring, timer, diff. */

import React from 'react';
import { Box, Text } from 'ink';
import type { ToolCallCard as ToolCallCardData } from '../dispatcher.js';
import { stripAnsi } from './ansi.js';

export interface ToolCallCardProps {
  card: ToolCallCardData;
  onToggleExpand: (toolId: string) => void;
}

// ---------------------------------------------------------------------------
// InlineDiff renderer
// ---------------------------------------------------------------------------

function renderDiff(raw: string): React.ReactElement {
  const lines = raw.split('\n');
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {lines.map((line, i) => {
        if (line.startsWith('+')) {
          return <Text key={i} color="#7acc7a">  {line}</Text>;
        } else if (line.startsWith('-')) {
          return <Text key={i} color="#dd6666">  {line}</Text>;
        } else if (line.startsWith('@@')) {
          return <Text key={i} dimColor>  {line}</Text>;
        } else {
          return <Text key={i}>  {line}</Text>;
        }
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// ToolCallCard component
// ---------------------------------------------------------------------------

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ card }) => {
  const { name, args, status, elapsedMs, resultPreview, resultFull, isDiff, expanded } = card;

  // Status ring
  let ring: React.ReactElement;
  if (status === 'running') {
    ring = <Text color="#e8b860">○</Text>;
  } else if (status === 'done') {
    ring = <Text color="#7acc7a">●</Text>;
  } else {
    ring = <Text color="#dd6666">✖</Text>;
  }

  // Strip ANSI from args/result before display to prevent terminal corruption.
  const safeArgs = stripAnsi(args);
  const maxArgLen = Math.max(4, 40 - name.length);
  const displayArgs = safeArgs.length > maxArgLen ? safeArgs.slice(0, Math.max(0, maxArgLen - 1)) + '…' : safeArgs;

  const safeResultPreview = stripAnsi(resultPreview ?? '');
  const previewLines = safeResultPreview || '0 lines';
  const safeResultFull = stripAnsi(resultFull);

  return (
    <Box flexDirection="column" paddingLeft={4}>
      {/* Collapsed header */}
      <Box>
        <Text dimColor>⏺ </Text>
        {name.startsWith('control.') || name.includes('IComputerUse') || name.includes('computer') ? (
          <Text color="#7acc7a" bold>🖥️ {name}</Text>
        ) : (
          <Text color="#e8b860">{name}</Text>
        )}
        <Text dimColor>({displayArgs})  </Text>
        {ring}
        <Text dimColor>  {elapsedMs}ms  ⎿ {previewLines}</Text>
      </Box>

      {/* Expanded content */}
      {expanded && (
        <Box flexDirection="column" marginTop={0}>
          <Text dimColor>{'  '}{'─'.repeat(66)}</Text>
          {isDiff ? renderDiff(safeResultFull) : (
            <Box paddingLeft={4}>
              <Text dimColor>{safeResultFull}</Text>
            </Box>
          )}
          <Text dimColor>{'  '}{'─'.repeat(66)}</Text>
        </Box>
      )}
    </Box>
  );
};

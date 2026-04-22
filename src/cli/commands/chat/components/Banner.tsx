/** @file Banner.tsx — First-run welcome banner. Dismissed on first printable keypress. */

import React from 'react';
import { Box, Text } from 'ink';

export interface BannerProps {
  model: string;
  providerLabel: string;
  connectedProviders: string[];
  lastSessionSummary: string | null;
  onDismiss: () => void;
}

export const Banner: React.FC<BannerProps> = ({
  model,
  providerLabel,
  connectedProviders,
  lastSessionSummary,
}) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 78);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="white"
      marginLeft={2}
      marginRight={2}
      marginBottom={1}
      paddingX={2}
      paddingY={0}
      width={width}
    >
      <Text>
        <Text color="#e8b860" bold>SUDO-AI</Text>
        <Text dimColor>  {model}  via {providerLabel}</Text>
      </Text>
      <Text dimColor>Connected providers: {connectedProviders.join(', ')}</Text>
      {lastSessionSummary ? (
        <Text dimColor>Last session: {lastSessionSummary}</Text>
      ) : (
        <Text dimColor>No previous session.</Text>
      )}
      <Text> </Text>
      <Text dimColor>Type a message to begin. /help for commands.</Text>
      <Text dimColor>(press any key to dismiss)</Text>
    </Box>
  );
};

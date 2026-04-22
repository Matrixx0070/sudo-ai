/** @file FederationModal.tsx — Federation peer list overlay (Ctrl+F). */

import React from 'react';
import { Box, Text } from 'ink';
import type { FederationData } from '../hooks/useFederation.js';

export interface FederationModalProps {
  federation: FederationData;
  onClose: () => void;
}

const STATUS_COLORS = {
  connected: '#7acc7a',
  degraded:  '#e8b860',
  offline:   '#dd6666',
} as const;

export const FederationModal: React.FC<FederationModalProps> = ({ federation }) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 72);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="#e8b860"
      marginLeft={2}
      marginRight={2}
      marginBottom={1}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Text bold>Federation Peers ({federation.count})</Text>
      <Text> </Text>
      {federation.peers.length === 0 ? (
        <Text dimColor>No peers connected.</Text>
      ) : (
        federation.peers.map(peer => {
          const truncId = peer.id.slice(0, 24);
          const statusColor = STATUS_COLORS[peer.status] ?? '#e8b860';
          return (
            <Box key={peer.id} marginBottom={0}>
              <Box width={26}>
                <Text color="#e8b860">{truncId}</Text>
              </Box>
              <Box width={30}>
                <Text dimColor>{peer.url}</Text>
              </Box>
              <Text color={statusColor}>{peer.status}</Text>
            </Box>
          );
        })
      )}
      <Text> </Text>
      <Text dimColor>Ctrl+F to close</Text>
    </Box>
  );
};

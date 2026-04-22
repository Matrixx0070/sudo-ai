/** @file PermissionDialog.tsx — Tool permission prompt: [Y]es / [N]o / [A]lways. */

import React from 'react';
import { Box, Text } from 'ink';

export interface PermissionDialogProps {
  toolName: string;
  args: string;
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: () => void;
}

export const PermissionDialog: React.FC<PermissionDialogProps> = ({
  toolName,
  args,
}) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 78);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#e8b860"
      marginLeft={2}
      marginRight={2}
      marginBottom={1}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Text>
        <Text>Allow </Text>
        <Text color="#e8b860">{toolName}</Text>
        <Text> </Text>
        <Text color="#e8b860">`{args}`</Text>
        <Text>?</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text color="#e8b860" bold>[Y]</Text>
        <Text>es   </Text>
        <Text color="#dd6666" bold>[N]</Text>
        <Text>o   </Text>
        <Text color="#e8b860" bold>[A]</Text>
        <Text>lways</Text>
      </Text>
    </Box>
  );
};

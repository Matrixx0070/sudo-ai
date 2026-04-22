import { useCallback, useEffect } from 'react';
import { ipcInvoke, ipcOn, ipcSend, type InvokeChannel, type ListenChannel, type SendChannel } from '@renderer/lib/ipc-client';

/** Send a fire-and-forget message to main process. Returns a stable callback. */
export function useIpcSend(channel: SendChannel) {
  return useCallback(
    (data: unknown) => {
      ipcSend(channel, data);
    },
    [channel]
  );
}

/** Listen to push events from main process. Cleans up on unmount. */
export function useIpcOn(
  channel: ListenChannel,
  callback: (...args: unknown[]) => void
): void {
  useEffect(() => {
    const unsubscribe = ipcOn(channel, callback);
    return () => {
      unsubscribe();
    };
    // callback intentionally excluded — callers must memoize if needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);
}

/** Request/response IPC. Returns a stable async function. */
export function useIpcInvoke<T = unknown>(channel: InvokeChannel) {
  return useCallback(
    (data?: unknown) => ipcInvoke<T>(channel, data),
    [channel]
  );
}

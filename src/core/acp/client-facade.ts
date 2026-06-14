/**
 * @file acp/client-facade.ts
 * @description Agent-side facade over the ACP client (gap #26 slice 3).
 *
 * The agent's tool layer should not know that fs/terminal ops are JSON-RPC
 * calls to the editor — it should call a typed method and receive a typed
 * result. {@link AcpClientFacade} is that protocol: a tiny interface with one
 * method per client-side capability. The standalone ACP entry constructs a
 * default impl over a {@link JsonRpcConnection} via {@link
 * makeJsonRpcClientFacade}; tests inject a stub so tool tests stay JSX-free
 * and require no wire.
 */

import type { JsonRpcConnection } from './jsonrpc.js';
import type {
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
  FsWriteTextFileResult,
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalOutputParams,
  TerminalOutputResult,
  TerminalWaitForExitParams,
  TerminalWaitForExitResult,
  TerminalKillParams,
  TerminalKillResult,
  TerminalReleaseParams,
  TerminalReleaseResult,
} from './types.js';

export interface AcpClientFacade {
  fsReadTextFile(params: FsReadTextFileParams): Promise<FsReadTextFileResult>;
  fsWriteTextFile(params: FsWriteTextFileParams): Promise<FsWriteTextFileResult>;
  terminalCreate(params: TerminalCreateParams): Promise<TerminalCreateResult>;
  terminalOutput(params: TerminalOutputParams): Promise<TerminalOutputResult>;
  terminalWaitForExit(params: TerminalWaitForExitParams): Promise<TerminalWaitForExitResult>;
  terminalKill(params: TerminalKillParams): Promise<TerminalKillResult>;
  terminalRelease(params: TerminalReleaseParams): Promise<TerminalReleaseResult>;
}

/**
 * Build the default ACP client facade that proxies every call through
 * `conn.sendRequest()` using the spec method names. Used by acp-main.ts. The
 * method name strings match the ACP spec exactly (slash-separated, not
 * dot-separated like the gateway).
 */
export function makeJsonRpcClientFacade(conn: JsonRpcConnection): AcpClientFacade {
  return {
    fsReadTextFile: (p) => conn.sendRequest<FsReadTextFileResult>('fs/read_text_file', p),
    fsWriteTextFile: (p) => conn.sendRequest<FsWriteTextFileResult>('fs/write_text_file', p),
    terminalCreate: (p) => conn.sendRequest<TerminalCreateResult>('terminal/create', p),
    terminalOutput: (p) => conn.sendRequest<TerminalOutputResult>('terminal/output', p),
    terminalWaitForExit: (p) =>
      conn.sendRequest<TerminalWaitForExitResult>('terminal/wait_for_exit', p),
    terminalKill: (p) => conn.sendRequest<TerminalKillResult>('terminal/kill', p),
    terminalRelease: (p) => conn.sendRequest<TerminalReleaseResult>('terminal/release', p),
  };
}

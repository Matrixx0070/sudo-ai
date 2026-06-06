/**
 * SUDO-AI v4 Shared Types Package
 *
 * Re-exports all type definitions for use across server and client.
 * Pure type definitions only - no runtime code.
 *
 * @packageDocumentation
 */

// Alignment types
export type {
  AlignmentLevel,
  AlignmentReport,
  TrustSnapshot,
  CalibrationReport,
  VetoThresholdData,
} from './alignment.js';

// Digest types
export type {
  DigestSnapshot,
  DigestResponse,
} from './digest.js';

// Admin API types
export type {
  MistakePattern,
  PatternsResponse,
  EpistemicTag,
  EpistemicDecision,
  EpistemicLogRow,
  EpistemicLogResponse,
  EpistemicStatsResponse,
  CommitmentRow,
  CommitmentsExpiringResponse,
  CommitmentResolution,
  CommitmentResolutionEntry,
  CommitmentResolveRequest,
  CommitmentResolveResponse,
  DiagnosticSpike,
  DiagnosticCorrelation,
  DiagnosticsResponse,
  InjectionStatsResponse,
  ReAnchorStatsResponse,
  ReAnchorEvent,
  ReAnchorRecentResponse,
  ChainVerifyResult,
  AuditVerifyResponse,
  InspectionStatus,
  InspectionQueueEntry,
  InspectionQueryResponse,
  InspectionStatusUpdateRequest,
  InspectionStatusUpdateResponse,
  VetoOverrideAction,
  VetoOverride,
  VetoOverrideRequest,
  VetoOverrideResponse,
  VetoOverrideListResponse,
  TrustResponse,
  CalibrationResponse,
  VetoThresholdResponse,
  PublicKeyInfo,
  PublicKeyResponse,
  KeyRotationResult,
  KeyRotationResponse,
  AlignmentResponse,
  RemediationStatsResponse,
  AdminEndpoints,
} from './admin-api.js';

// WebSocket chat types
export type {
  ThinkingMessage,
  ProgressMessage,
  UserEchoMessage,
  ReplyMessage,
  ErrorMessage,
  ChatWSReceiveMessage,
  ChatWSSendMessage,
  ChatWSOptions,
} from './chat-ws.js';

// Bridge protocol types (IDE extension protocol — zero runtime deps)
export type {
  BridgeConnectionPhase,
  BridgeMultiplexMode,
  BridgeClientMessage,
  BridgeServerResponse,
  BridgeServerEvent,
  BridgeServerMessage,
  BridgeMethod,
  BridgeEventType,
  BridgeErrorCodeType,
  BridgeError,
  InitializeParams,
  InitializeResult,
  BridgeClientCapabilities,
  BridgeServerCapabilities,
  BridgeChatSendParams,
  BridgeChatSendResult,
  SetModelParams,
  SetPermissionModeParams,
  CanUseToolParams,
  CanUseToolResult,
  InterruptParams,
  StreamStartEvent,
  StreamTokenEvent,
  StreamThinkingEvent,
  StreamToolCallEvent,
  StreamToolResultEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  HeartbeatEvent,
  BridgeDiscoveryPayload,
  BridgeSessionCreateParams,
  BridgeSessionCreateResult,
  BridgeSessionInfo,
  BridgeSessionArchiveParams,
} from './bridge-protocol.js';

export { BRIDGE_PROTOCOL_VERSION, BridgeErrorCode } from './bridge-protocol.js';

// Type guards (runtime functions for TypeScript type narrowing)
export {
  isThinkingMessage,
  isProgressMessage,
  isUserEchoMessage,
  isReplyMessage,
  isErrorMessage,
} from './chat-ws.js';

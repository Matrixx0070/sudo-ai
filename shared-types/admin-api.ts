/**
 * Admin REST API endpoint types for SUDO-AI v4.
 * Maps each GET /v1/admin/* endpoint to its response type.
 * Pure type definitions - no runtime code.
 */

import type { AlignmentReport, TrustSnapshot, CalibrationReport, VetoThresholdData } from './alignment.js';
import type { DigestSnapshot } from './digest.js';

// ---------------------------------------------------------------------------
// Mistake Patterns
// ---------------------------------------------------------------------------

export type MistakePattern = {
  signatureHash: string;
  signature: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  tags: string[];
};

export type PatternsResponse = {
  ok: boolean;
  data: {
    patterns: MistakePattern[];
    totalMistakes: number;
    uniquePatterns: number;
    window: number;
    analyzedAt: string;
  };
};

// ---------------------------------------------------------------------------
// Epistemic Gate
// ---------------------------------------------------------------------------

export type EpistemicTag = 'CERTAIN' | 'PROBABLE' | 'CONJECTURE' | 'UNKNOWN';
export type EpistemicDecision = 'PASS' | 'BLOCK' | 'UNCERTAIN';

export type EpistemicLogRow = {
  id: string;
  ts: number;
  tag: EpistemicTag;
  decision: EpistemicDecision;
  text: string;
  skillId?: string;
  toolCallId?: string;
};

export type EpistemicLogResponse = {
  ok: boolean;
  data: {
    entries: EpistemicLogRow[];
    count: number;
  };
};

export type EpistemicStatsResponse = {
  ok: boolean;
  data: {
    total: number;
    byTag: Record<EpistemicTag, number>;
    byDecision: Record<EpistemicDecision, number>;
    blockRate: number;
    window: { sinceMs: number; untilMs: number };
  };
};

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

export type CommitmentRow = {
  id: string;
  commitment: string;
  learned: string;
  mistake: string;
  createdAt: string;
  expiresAt: string;
  ttlDays: number;
};

export type CommitmentsExpiringResponse = {
  ok: boolean;
  data: {
    expiring: CommitmentRow[];
    expired: CommitmentRow[];
    window: number;
    checkedAt: string;
  };
};

export type CommitmentResolution = 'honored' | 'abandoned' | 'expired-acknowledged';

export type CommitmentResolutionEntry = {
  id: string;
  commitmentRef: string;
  resolution: CommitmentResolution;
  ts: number;
  notes?: string;
};

export type CommitmentResolveRequest = {
  commitmentRef: string;
  resolution: CommitmentResolution;
  notes?: string;
};

export type CommitmentResolveResponse = {
  ok: boolean;
  data: CommitmentResolutionEntry;
};

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSpike = {
  source: string;
  kind: string;
  ts: number;
  count: number;
};

export type DiagnosticCorrelation = {
  leadingSpike: DiagnosticSpike;
  trailingSpike: DiagnosticSpike;
  deltaMs: number;
  confidence: number;
};

export type DiagnosticsResponse = {
  ok: boolean;
  data: {
    windowDays: number;
    trustSpikes: DiagnosticSpike[];
    epistemicBlockSpikes: DiagnosticSpike[];
    vetoSpikes: DiagnosticSpike[];
    commitmentExpirySpikes: DiagnosticSpike[];
    correlations: DiagnosticCorrelation[];
    analyzedAt: string;
    totalEventsScanned: number;
  };
};

// ---------------------------------------------------------------------------
// Injection Stats
// ---------------------------------------------------------------------------

export type InjectionStatsResponse = {
  ok: boolean;
  data: {
    detections: {
      count: number;
      score: number;
    } | null;
    totalCount: number;
    totalScore: number;
    windowDays: number;
    computedAt: string;
  };
};

// ---------------------------------------------------------------------------
// Re-Anchor
// ---------------------------------------------------------------------------

export type ReAnchorStatsResponse = {
  ok: boolean;
  data: {
    total: number;
    byTrigger: Record<string, number>;
    windowDays: number;
    computedAt: string;
    lastReAnchorAt?: number;
  };
};

export type ReAnchorEvent = {
  id: string;
  ts: number;
  trigger: string;
  snippet: string;
};

export type ReAnchorRecentResponse = {
  ok: boolean;
  data: {
    events: ReAnchorEvent[];
    count: number;
    windowDays: number;
    computedAt: string;
  };
};

// ---------------------------------------------------------------------------
// Audit Trail
// ---------------------------------------------------------------------------

export type ChainVerifyResult = {
  ok: boolean;
  rowsChecked: number;
  breakAt?: number;
  reason?: string;
};

export type AuditVerifyResponse = {
  ok: boolean;
  data: ChainVerifyResult & {
    validCount: number;
    invalidCount: number;
  };
};

// ---------------------------------------------------------------------------
// Inspection Queue
// ---------------------------------------------------------------------------

export type InspectionStatus = 'pending' | 'reviewed' | 'cleared' | 'blocked';

export type InspectionQueueEntry = {
  id: string;
  status: InspectionStatus;
  reviewedBy?: string;
  createdAt: string;
  updatedAt: string;
  // Additional fields depend on inspection-queue.ts implementation
  [key: string]: unknown;
};

export type InspectionQueryResponse = {
  ok: boolean;
  data: {
    entries: InspectionQueueEntry[];
    count: number;
  };
};

export type InspectionStatusUpdateRequest = {
  status: InspectionStatus;
  reviewedBy?: string;
};

export type InspectionStatusUpdateResponse = {
  ok: boolean;
  data: {
    id: string;
    status: InspectionStatus;
  };
};

// ---------------------------------------------------------------------------
// Veto Override
// ---------------------------------------------------------------------------

export type VetoOverrideAction = 'allow' | 'deny';

export type VetoOverride = {
  id: string;
  decisionId: string;
  contentHash?: string | null;
  action: VetoOverrideAction;
  reason: string;
  createdBy: string;
  createdAt: string;
};

export type VetoOverrideRequest = {
  decisionId?: string;
  contentHash?: string;
  action: VetoOverrideAction;
  reason: string;
};

export type VetoOverrideResponse = {
  ok: boolean;
  data: VetoOverride;
};

export type VetoOverrideListResponse = {
  ok: boolean;
  data: {
    overrides: VetoOverride[];
    count: number;
  };
};

// ---------------------------------------------------------------------------
// Trust Tier
// ---------------------------------------------------------------------------

export type TrustResponse = {
  ok: boolean;
  data: {
    tier: string;
    score: number;
    windowDays: number;
    computedAt: string;
  };
};

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export type CalibrationResponse = {
  ok: boolean;
  data: CalibrationReport;
};

// ---------------------------------------------------------------------------
// Veto Threshold
// ---------------------------------------------------------------------------

export type VetoThresholdResponse = {
  ok: boolean;
  data: VetoThresholdData;
};

// ---------------------------------------------------------------------------
// Public Key
// ---------------------------------------------------------------------------

export type PublicKeyInfo = {
  keyId: string;
  keyVersion?: number;
  algorithm: string;
  publicKey: string;
  generatedAt: string;
  retiring?: string | null;
};

export type PublicKeyResponse = {
  ok: boolean;
  data: PublicKeyInfo;
};

// ---------------------------------------------------------------------------
// Key Rotation
// ---------------------------------------------------------------------------

export type KeyRotationResult = {
  keyId: string;
  keyVersion: number;
  algorithm: string;
  generatedAt: string;
  idempotent: boolean;
  retiredKeyId?: string;
  retiredKeyVersion?: number;
};

export type KeyRotationResponse = {
  ok: boolean;
  data: KeyRotationResult;
};

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

export type AlignmentResponse = {
  ok: boolean;
  data: AlignmentReport;
};

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export type DigestResponse = {
  ok: boolean;
  data: DigestSnapshot;
};

// ---------------------------------------------------------------------------
// Remediation Stats (Wave 8E)
// ---------------------------------------------------------------------------

export type RemediationStatsResponse = {
  ok: boolean;
  data: {
    observationCount: number;
    remediationsTriggered: number;
    lastRemediationAt?: number;
    lastStatus: string;
    inCooldown: boolean;
  };
};

// ---------------------------------------------------------------------------
// Admin API Map - Union of all endpoint responses
// ---------------------------------------------------------------------------

export type AdminEndpoints = {
  '/v1/admin/audit/verify': { response: AuditVerifyResponse };
  '/v1/admin/inspection': { response: InspectionQueryResponse };
  '/v1/admin/veto/threshold': { response: VetoThresholdResponse };
  '/v1/admin/veto/override': { response: VetoOverrideResponse };
  '/v1/admin/veto/overrides': { response: VetoOverrideListResponse };
  '/v1/admin/alignment': { response: AlignmentResponse };
  '/v1/admin/epistemic/log': { response: EpistemicLogResponse };
  '/v1/admin/commitments/expiring': { response: CommitmentsExpiringResponse };
  '/v1/admin/epistemic/stats': { response: EpistemicStatsResponse };
  '/v1/admin/trust': { response: TrustResponse };
  '/v1/admin/patterns': { response: PatternsResponse };
  '/v1/admin/calibration': { response: CalibrationResponse };
  '/v1/admin/diagnostics': { response: DiagnosticsResponse };
  '/v1/admin/injection/stats': { response: InjectionStatsResponse };
  '/v1/admin/reanchor/stats': { response: ReAnchorStatsResponse };
  '/v1/admin/reanchor/recent': { response: ReAnchorRecentResponse };
  '/v1/admin/commitments/resolve': { request: CommitmentResolveRequest; response: CommitmentResolveResponse };
  '/v1/admin/digest': { response: DigestResponse };
  '/v1/admin/public-key': { response: PublicKeyResponse };
  '/v1/admin/key/rotate': { response: KeyRotationResponse };
  '/v1/admin/remediation/stats': { response: RemediationStatsResponse };
};

/**
 * Shared types for the TrendRadar awareness module.
 */

export interface TrendItem {
  id: string;
  title: string;
  source: 'hackernews' | 'reddit' | 'google_trends';
  url?: string;
  score: number;
  category?: string;
  matchesNiche: boolean;
  detectedAt: string;
  metadata?: Record<string, unknown>;
}

export interface TrendAlert {
  id?: number;
  trend: TrendItem;
  reason: string;
  suggestedAction: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  acknowledged?: boolean;
  createdAt?: string;
}

/**
 * Earning engine type definitions.
 */

export interface VideoMetrics {
  youtubeId: string;
  title: string;
  views: number;
  watchTimeHours: number;
  subscribersGained: number;
  likes: number;
  estimatedRevenue: number;
  ctr: number;
  avgViewDuration: number;
  recordedAt: string;
}

export interface RevenueReport {
  period: string;
  totalRevenue: number;
  totalViews: number;
  topVideos: VideoMetrics[];
  costVsRevenue: number;
}

export interface OptimizationResult {
  recommendations: string[];
  topicScores: Record<string, number>;
  bestUploadTime: string;
}

export interface RevenueMilestone {
  amount: number;
  label: string;
  reachedAt?: string;
}

export interface ROIReport {
  totalRevenue: number;
  totalApiCost: number;
  roi: number; // (revenue - cost) / cost * 100
  profitableVideos: number;
  totalVideos: number;
}

export interface CohortAnalysis {
  avgViews: number;
  avgWatchTimeHours: number;
  avgCtr: number;
  avgRevenue: number;
  topTopics: string[];
  weakestVideos: VideoMetrics[];
}

// ---------------------------------------------------------------------------
// YouTube API response shapes (minimal subset used)
// ---------------------------------------------------------------------------

export interface YouTubeAnalyticsRow {
  // YouTube Analytics API returns rows as arrays mapped to column headers.
  [key: string]: string | number;
}

export interface YouTubeAnalyticsResponse {
  kind: string;
  columnHeaders: Array<{ name: string; columnType: string; dataType: string }>;
  rows: YouTubeAnalyticsRow[];
}

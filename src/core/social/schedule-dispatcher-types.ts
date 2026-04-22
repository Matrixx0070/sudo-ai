/**
 * @file schedule-dispatcher-types.ts
 * @description Types for the social post schedule dispatcher.
 */

export type PostStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledPost {
  id: string;
  content: string;
  platforms: string[];
  mediaUrls: string[];
  scheduleTime: string;
  createdAt: string;
  status: PostStatus;
  dispatchedAt?: string;
  errorMessage?: string;
  retryCount: number;
}

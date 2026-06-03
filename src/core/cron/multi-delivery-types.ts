/**
 * Multi-Delivery Cron Job Types
 *
 * Defines the data structures for cron jobs that can deliver results
 * to multiple targets (local, telegram, discord, slack, email, webhook).
 */

/** Delivery target configuration */
export interface DeliveryTarget {
  type: 'local' | 'telegram' | 'discord' | 'slack' | 'email' | 'webhook';
  config: Record<string, unknown>;
  // telegram: { botToken: string, chatId: string }
  // discord: { webhookUrl: string }
  // slack: { webhookUrl: string }
  // email: { to: string, subject?: string }
  // webhook: { url: string, headers?: Record<string, string> }
  // local: {} (no config needed)
}

/** Cron job schedule configuration */
export interface CronSchedule {
  type: 'cron' | 'interval';
  value: string; // cron expression (e.g., "0 * * * *") or interval ms (e.g., "3600000")
}

/** Cron job definition */
export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  prompt: string;
  skills: string[];
  deliver: DeliveryTarget[];
  repeat?: { times: number; completed: number };
  enabled: boolean;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Result of delivery to a single target */
export interface DeliveryResult {
  target: DeliveryTarget;
  success: boolean;
  error?: string;
  deliveredAt: string;
}

/** Database row representation */
export interface CronJobRow {
  id: string;
  name: string;
  schedule_type: 'cron' | 'interval';
  schedule_value: string;
  prompt: string;
  skills: string; // JSON array
  deliver: string; // JSON array
  repeat_times: number | null;
  repeat_completed: number | null;
  enabled: number; // 0 or 1
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

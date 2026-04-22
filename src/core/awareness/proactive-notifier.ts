/**
 * @file proactive-notifier.ts
 * @description Upgrade 65 — Proactive Notifications.
 *
 * SUDO-AI notices things and alerts the user without being asked.
 * Subscribers register via `onNotification`; the UI or Telegram adapter
 * listens and forwards alerts.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('awareness:notifier');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationType = 'alert' | 'suggestion' | 'reminder' | 'discovery' | 'warning';

export interface ProactiveNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  dismissed: boolean;
  createdAt: string;
}

type NotificationHandler = (n: ProactiveNotification) => void;

// ---------------------------------------------------------------------------
// In-memory store (capped at 500)
// ---------------------------------------------------------------------------

const MAX_NOTIFS = 500;
const TRIM_TO    = 250;

const notifications: ProactiveNotification[] = [];
const listeners: NotificationHandler[]        = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a proactive notification and broadcast it to all registered handlers.
 */
export function notify(
  type: NotificationType,
  title: string,
  message: string,
  priority: ProactiveNotification['priority'] = 'medium',
): ProactiveNotification {
  if (!title)   throw new TypeError('title is required');
  if (!message) throw new TypeError('message is required');

  const n: ProactiveNotification = {
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    title,
    message,
    priority,
    dismissed: false,
    createdAt: new Date().toISOString(),
  };

  notifications.push(n);
  if (notifications.length > MAX_NOTIFS) notifications.splice(0, MAX_NOTIFS - TRIM_TO);

  for (const l of listeners) {
    try {
      l(n);
    } catch (err) {
      log.error({ err }, 'Notification handler threw');
    }
  }

  log.info({ type, priority, title }, message.substring(0, 80));
  return n;
}

/**
 * Subscribe to all future notifications.
 * Returns an unsubscribe function.
 */
export function onNotification(handler: NotificationHandler): () => void {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  listeners.push(handler);
  return () => {
    const idx = listeners.indexOf(handler);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/** All notifications that have not been dismissed. */
export function getUnread(): ProactiveNotification[] {
  return notifications.filter(n => !n.dismissed);
}

/** Dismiss a single notification by id. */
export function dismiss(id: string): void {
  if (!id) throw new TypeError('id is required');
  const n = notifications.find(n => n.id === id);
  if (n) n.dismissed = true;
}

/** Dismiss every pending notification. */
export function dismissAll(): void {
  for (const n of notifications) n.dismissed = true;
}

/** Get undismissed notifications filtered by priority. */
export function getByPriority(
  priority: ProactiveNotification['priority'],
): ProactiveNotification[] {
  return notifications.filter(n => n.priority === priority && !n.dismissed);
}

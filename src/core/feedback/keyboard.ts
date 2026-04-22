/**
 * Feedback keyboard — builds Telegram InlineKeyboard for task feedback.
 *
 * Callback data format:  fb:{rating}:{feedbackId}
 *   rating:     good | bad | skip
 *   feedbackId: UUID stored in feedback table (pending, rating=skip until the owner taps)
 *
 * The TelegramAdapter registers a callback_query handler that processes these.
 */

import { InlineKeyboard } from 'grammy';
import { randomUUID } from 'node:crypto';
import { saveFeedback, detectTaskType } from './store.js';

export interface PendingFeedback {
  feedbackId: string;
  keyboard: InlineKeyboard;
}

/**
 * Create a pending feedback entry (rating=skip placeholder) and return
 * the InlineKeyboard to attach to the reply message.
 *
 * @param sessionId  - Agent session that produced the reply
 * @param taskSummary - First 120 chars of the reply / task description
 * @param channel    - 'telegram'
 */
export function createFeedbackKeyboard(
  sessionId: string,
  taskSummary: string,
  channel = 'telegram',
): PendingFeedback {
  const feedbackId = randomUUID();
  const taskType   = detectTaskType(taskSummary);

  // Pre-save with rating=skip so we have a record even if the owner never taps
  saveFeedback({
    session_id:   sessionId,
    channel,
    task_summary: taskSummary.slice(0, 200),
    task_type:    taskType,
    rating:       'skip',
    notes:        null,
  });

  const keyboard = new InlineKeyboard()
    .text('👍 Good', `fb:good:${feedbackId}`)
    .text('👎 Bad',  `fb:bad:${feedbackId}`)
    .text('⏭️ Skip', `fb:skip:${feedbackId}`);

  return { feedbackId, keyboard };
}

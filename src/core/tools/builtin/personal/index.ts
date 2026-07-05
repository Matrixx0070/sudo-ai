/**
 * Personal Productivity toolkit — registers 4 personal tools into the ToolRegistry.
 *
 * Tools registered:
 *   personal.task-inbox       — Personal task management with smart scheduling
 *   personal.calendar-manager — Smart calendar with conflict detection (wraps business.calendar)
 *   personal.reminder-system  — Context-aware reminders (time/trigger-based, JSON persistence)
 *   personal.email-manager    — Triage, prioritise, and draft replies for email inboxes (LLM)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { DATA_DIR } from '../../../shared/paths.js';
import { normalizeBrainText } from '../../../brain/brain-text.js';

const logger = createLogger('personal-builtin');

const INBOX_FILE = path.join(DATA_DIR, 'personal-inbox.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'personal-reminders.json');

// ---------------------------------------------------------------------------
// Shared LLM helper
// ---------------------------------------------------------------------------

interface BrainLike {
  // Brain.chat() resolves to a STRING (not { content }). normalizeBrainText handles it
  // null-safely — the old `.content.trim()` crashed every call.
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

interface ConfigLike { brain?: BrainLike; }

async function askBrain(ctx: ToolContext, system: string, user: string): Promise<string> {
  const config = ctx.config as ConfigLike | undefined;
  if (!config?.brain) throw new Error('Brain (LLM) is not available. Ensure the brain module is configured.');
  const response = await config.brain.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return normalizeBrainText(response).trim();
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// personal.task-inbox
// ---------------------------------------------------------------------------

type InboxStatus = 'inbox' | 'today' | 'scheduled' | 'someday' | 'done' | 'deleted';

interface InboxTask {
  id: string;
  title: string;
  notes: string;
  status: InboxStatus;
  context?: string;
  energy?: 'low' | 'medium' | 'high';
  scheduledFor?: string;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

function loadInbox(): InboxTask[] {
  try {
    if (!existsSync(INBOX_FILE)) return [];
    return JSON.parse(readFileSync(INBOX_FILE, 'utf8')) as InboxTask[];
  } catch { return []; }
}

function saveInbox(tasks: InboxTask[]): void {
  ensureDataDir();
  writeFileSync(INBOX_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

const taskInboxTool: ToolDefinition = {
  name: 'personal.task-inbox',
  description:
    'Personal GTD-style task inbox with smart scheduling. Capture tasks, process to next-actions, schedule, or defer. Persists to data/personal-inbox.json.',
  category: 'personal',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['capture', 'process', 'list', 'update', 'schedule', 'complete', 'delete', 'review'],
    },
    taskId: { type: 'string', description: 'Task ID (required for update, schedule, complete, delete).' },
    title: { type: 'string', description: 'Task title (required for capture).' },
    notes: { type: 'string', description: 'Additional notes or context.' },
    context: { type: 'string', description: 'Context tag (e.g. @computer, @phone, @errands, @home).' },
    energy: { type: 'string', description: 'Energy level required.', enum: ['low', 'medium', 'high'] },
    scheduledFor: { type: 'string', description: 'Date to schedule task (YYYY-MM-DD).' },
    dueDate: { type: 'string', description: 'Hard deadline (YYYY-MM-DD).' },
    status: { type: 'string', description: 'Status to move task to.', enum: ['inbox', 'today', 'scheduled', 'someday', 'done', 'deleted'] },
    view: { type: 'string', description: 'View for list action.', enum: ['inbox', 'today', 'all', 'someday', 'overdue'], default: 'inbox' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'personal.task-inbox invoked');

    try {
      const tasks = loadInbox();

      switch (action) {
        case 'capture': {
          const title = params['title'] as string | undefined;
          if (!title?.trim()) return { success: false, output: 'title is required for capture.' };
          const now = new Date().toISOString();
          const task: InboxTask = {
            id: crypto.randomUUID(),
            title,
            notes: (params['notes'] as string | undefined) ?? '',
            status: 'inbox',
            context: params['context'] as string | undefined,
            energy: params['energy'] as InboxTask['energy'] | undefined,
            scheduledFor: params['scheduledFor'] as string | undefined,
            dueDate: params['dueDate'] as string | undefined,
            createdAt: now,
            updatedAt: now,
          };
          tasks.push(task);
          saveInbox(tasks);
          return { success: true, output: `Captured: "${title}" (id: ${task.id})`, data: task };
        }

        case 'process': {
          const inbox = tasks.filter(t => t.status === 'inbox');
          if (inbox.length === 0) return { success: true, output: 'Inbox is empty. Nothing to process.' };
          return {
            success: true,
            output: `${inbox.length} item(s) in inbox:\n${inbox.map(t => `${t.id}: "${t.title}"${t.notes ? ` — ${t.notes}` : ''}`).join('\n')}\n\nProcess each with update/schedule/complete.`,
            data: inbox,
          };
        }

        case 'list': {
          const view = (params['view'] as string | undefined) ?? 'inbox';
          const today = new Date().toISOString().split('T')[0]!;
          let filtered: InboxTask[];
          if (view === 'today') filtered = tasks.filter(t => t.status === 'today' || t.scheduledFor === today);
          else if (view === 'all') filtered = tasks.filter(t => t.status !== 'done' && t.status !== 'deleted');
          else if (view === 'someday') filtered = tasks.filter(t => t.status === 'someday');
          else if (view === 'overdue') filtered = tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== 'done' && t.status !== 'deleted');
          else filtered = tasks.filter(t => t.status === 'inbox');
          return {
            success: true,
            output: filtered.length > 0
              ? `${view} (${filtered.length}):\n${filtered.map(t => `[${t.status}]${t.context ? `[${t.context}]` : ''} ${t.title}${t.dueDate ? ` DUE:${t.dueDate}` : ''}`).join('\n')}`
              : `No tasks in ${view}.`,
            data: filtered,
          };
        }

        case 'update': {
          const taskId = params['taskId'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx === -1) return { success: false, output: `Task not found: ${taskId}` };
          const t = tasks[idx]!;
          if (params['title']) t.title = params['title'] as string;
          if (params['notes']) t.notes = params['notes'] as string;
          if (params['status']) t.status = params['status'] as InboxStatus;
          if (params['context']) t.context = params['context'] as string;
          if (params['energy']) t.energy = params['energy'] as InboxTask['energy'];
          if (params['scheduledFor']) t.scheduledFor = params['scheduledFor'] as string;
          if (params['dueDate']) t.dueDate = params['dueDate'] as string;
          t.updatedAt = new Date().toISOString();
          saveInbox(tasks);
          return { success: true, output: `Task updated: "${t.title}"`, data: t };
        }

        case 'schedule': {
          const taskId = params['taskId'] as string | undefined;
          const scheduledFor = params['scheduledFor'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          if (!scheduledFor) return { success: false, output: 'scheduledFor date is required.' };
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx === -1) return { success: false, output: `Task not found: ${taskId}` };
          tasks[idx]!.scheduledFor = scheduledFor;
          tasks[idx]!.status = 'scheduled';
          tasks[idx]!.updatedAt = new Date().toISOString();
          saveInbox(tasks);
          return { success: true, output: `Task scheduled for ${scheduledFor}: "${tasks[idx]!.title}"`, data: tasks[idx] };
        }

        case 'complete': {
          const taskId = params['taskId'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx === -1) return { success: false, output: `Task not found: ${taskId}` };
          tasks[idx]!.status = 'done';
          tasks[idx]!.updatedAt = new Date().toISOString();
          saveInbox(tasks);
          return { success: true, output: `Completed: "${tasks[idx]!.title}"` };
        }

        case 'delete': {
          const taskId = params['taskId'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx === -1) return { success: false, output: `Task not found: ${taskId}` };
          tasks[idx]!.status = 'deleted';
          tasks[idx]!.updatedAt = new Date().toISOString();
          saveInbox(tasks);
          return { success: true, output: `Deleted: "${tasks[idx]!.title}"` };
        }

        case 'review': {
          const today = new Date().toISOString().split('T')[0]!;
          const inboxCount = tasks.filter(t => t.status === 'inbox').length;
          const todayCount = tasks.filter(t => t.status === 'today' || t.scheduledFor === today).length;
          const overdueCount = tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== 'done' && t.status !== 'deleted').length;
          return { success: true, output: `Daily review: ${inboxCount} in inbox | ${todayCount} today | ${overdueCount} overdue`, data: { inboxCount, todayCount, overdueCount } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'personal.task-inbox error');
      return { success: false, output: `Task inbox error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// personal.calendar-manager
// ---------------------------------------------------------------------------

const calendarManagerTool: ToolDefinition = {
  name: 'personal.calendar-manager',
  description:
    'Smart personal calendar with conflict detection. List, create, update, and delete events. Checks for scheduling conflicts before creating. Wraps business.calendar.',
  category: 'personal',
  timeout: 30_000,
  parameters: {
    action: { type: 'string', required: true, description: 'Calendar operation.', enum: ['list', 'create', 'update', 'delete', 'check-conflicts'] },
    eventId: { type: 'string', description: 'Event ID (required for update, delete).' },
    title: { type: 'string', description: 'Event title (required for create).' },
    start: { type: 'string', description: 'Start datetime ISO 8601 (required for create, check-conflicts).' },
    end: { type: 'string', description: 'End datetime ISO 8601 (required for create, check-conflicts).' },
    description: { type: 'string', description: 'Event description.' },
    location: { type: 'string', description: 'Event location.' },
    startDate: { type: 'string', description: 'Start date for list (YYYY-MM-DD).' },
    endDate: { type: 'string', description: 'End date for list (YYYY-MM-DD).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'personal.calendar-manager invoked');

    try {
      // Delegate to business.calendar which has the full Google Calendar integration
      const { CalendarClient } = await import('../../../business/calendar.js');
      const client = new CalendarClient();

      switch (action) {
        case 'list': {
          const startDate = (params['startDate'] as string | undefined) ?? new Date().toISOString().split('T')[0]!;
          const endDate = (params['endDate'] as string | undefined) ?? new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0]!;
          const events = await client.listEvents(startDate, endDate);
          return {
            success: true,
            output: events.length > 0
              ? `${events.length} event(s) from ${startDate} to ${endDate}:\n${events.map(e => `${e.start}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n')}`
              : 'No events in that range.',
            data: events,
          };
        }

        case 'check-conflicts': {
          const start = params['start'] as string | undefined;
          const end = params['end'] as string | undefined;
          if (!start || !end) return { success: false, output: 'start and end are required for conflict check.' };
          const date = start.split('T')[0]!;
          const events = await client.listEvents(date, date);
          const conflicts = events.filter(e => {
            const eStart = new Date(e.start).getTime();
            const eEnd = new Date(e.end ?? e.start).getTime();
            const newStart = new Date(start).getTime();
            const newEnd = new Date(end).getTime();
            return newStart < eEnd && newEnd > eStart;
          });
          return {
            success: true,
            output: conflicts.length > 0
              ? `${conflicts.length} conflict(s) found:\n${conflicts.map(e => `${e.start}-${e.end}: ${e.title}`).join('\n')}`
              : `No conflicts for ${start} — ${end}.`,
            data: { hasConflict: conflicts.length > 0, conflicts },
          };
        }

        case 'create': {
          const title = params['title'] as string | undefined;
          const start = params['start'] as string | undefined;
          const end = params['end'] as string | undefined;
          if (!title?.trim()) return { success: false, output: 'title is required.' };
          if (!start) return { success: false, output: 'start datetime is required.' };
          if (!end) return { success: false, output: 'end datetime is required.' };
          const event = await client.createEvent({ title, start, end, description: params['description'] as string | undefined, location: params['location'] as string | undefined });
          return { success: true, output: `Event created: "${event.title}" on ${event.start}`, data: event };
        }

        case 'update': {
          const eventId = params['eventId'] as string | undefined;
          if (!eventId?.trim()) return { success: false, output: 'eventId is required.' };
          const patch: Record<string, unknown> = {};
          if (params['title']) patch['title'] = params['title'];
          if (params['start']) patch['start'] = params['start'];
          if (params['end']) patch['end'] = params['end'];
          if (params['description']) patch['description'] = params['description'];
          if (params['location']) patch['location'] = params['location'];
          const updated = await client.updateEvent(eventId, patch);
          return { success: true, output: `Event updated: ${eventId}`, data: updated };
        }

        case 'delete': {
          const eventId = params['eventId'] as string | undefined;
          if (!eventId?.trim()) return { success: false, output: 'eventId is required.' };
          await client.deleteEvent(eventId);
          return { success: true, output: `Event deleted: ${eventId}` };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'personal.calendar-manager error');
      return { success: false, output: `Calendar manager error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// personal.reminder-system
// ---------------------------------------------------------------------------

interface Reminder {
  id: string;
  title: string;
  message: string;
  type: 'time' | 'trigger';
  triggerAt?: string;
  triggerCondition?: string;
  repeat?: 'none' | 'daily' | 'weekly';
  status: 'pending' | 'fired' | 'cancelled';
  createdAt: string;
}

function loadReminders(): Reminder[] {
  try {
    if (!existsSync(REMINDERS_FILE)) return [];
    return JSON.parse(readFileSync(REMINDERS_FILE, 'utf8')) as Reminder[];
  } catch { return []; }
}

function saveReminders(reminders: Reminder[]): void {
  ensureDataDir();
  writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), 'utf8');
}

const reminderSystemTool: ToolDefinition = {
  name: 'personal.reminder-system',
  description:
    'Context-aware reminder system. Set time-based and trigger-based reminders, list pending reminders, and check for due reminders. Persists to data/personal-reminders.json.',
  category: 'personal',
  timeout: 15_000,
  parameters: {
    action: { type: 'string', required: true, description: 'Operation.', enum: ['set', 'list', 'check-due', 'cancel', 'stats'] },
    reminderId: { type: 'string', description: 'Reminder ID (required for cancel).' },
    title: { type: 'string', description: 'Reminder title (required for set).' },
    message: { type: 'string', description: 'Reminder message text.' },
    type: { type: 'string', description: 'Reminder type.', enum: ['time', 'trigger'], default: 'time' },
    triggerAt: { type: 'string', description: 'ISO 8601 datetime for time-based reminders.' },
    triggerCondition: { type: 'string', description: 'Condition description for trigger-based reminders (e.g. "when stock price > 150").' },
    repeat: { type: 'string', description: 'Repeat schedule.', enum: ['none', 'daily', 'weekly'], default: 'none' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'personal.reminder-system invoked');

    try {
      const reminders = loadReminders();

      switch (action) {
        case 'set': {
          const title = params['title'] as string | undefined;
          if (!title?.trim()) return { success: false, output: 'title is required.' };
          const type = (params['type'] as Reminder['type'] | undefined) ?? 'time';
          if (type === 'time' && !params['triggerAt']) return { success: false, output: 'triggerAt is required for time-based reminders.' };
          if (type === 'trigger' && !params['triggerCondition']) return { success: false, output: 'triggerCondition is required for trigger-based reminders.' };
          const reminder: Reminder = {
            id: crypto.randomUUID(),
            title,
            message: (params['message'] as string | undefined) ?? title,
            type,
            triggerAt: params['triggerAt'] as string | undefined,
            triggerCondition: params['triggerCondition'] as string | undefined,
            repeat: (params['repeat'] as Reminder['repeat'] | undefined) ?? 'none',
            status: 'pending',
            createdAt: new Date().toISOString(),
          };
          reminders.push(reminder);
          saveReminders(reminders);
          const trigger = type === 'time' ? `at ${reminder.triggerAt}` : `when: ${reminder.triggerCondition}`;
          return { success: true, output: `Reminder set: "${title}" ${trigger}${reminder.repeat !== 'none' ? ` (repeats ${reminder.repeat})` : ''} (id: ${reminder.id})`, data: reminder };
        }

        case 'list': {
          const pending = reminders.filter(r => r.status === 'pending');
          return {
            success: true,
            output: pending.length > 0
              ? `${pending.length} pending reminder(s):\n${pending.map(r => `[${r.type}] "${r.title}" — ${r.triggerAt ?? r.triggerCondition}${r.repeat !== 'none' ? ` [${r.repeat}]` : ''}`).join('\n')}`
              : 'No pending reminders.',
            data: pending,
          };
        }

        case 'check-due': {
          const now = new Date().toISOString();
          const due = reminders.filter(r => r.status === 'pending' && r.type === 'time' && r.triggerAt && r.triggerAt <= now);
          for (const r of due) {
            if (r.repeat === 'none') {
              r.status = 'fired';
            } else if (r.repeat === 'daily') {
              r.triggerAt = new Date(new Date(r.triggerAt!).getTime() + 86_400_000).toISOString();
            } else if (r.repeat === 'weekly') {
              r.triggerAt = new Date(new Date(r.triggerAt!).getTime() + 7 * 86_400_000).toISOString();
            }
          }
          saveReminders(reminders);
          return {
            success: true,
            output: due.length > 0
              ? `${due.length} reminder(s) due:\n${due.map(r => `REMINDER: "${r.title}" — ${r.message}`).join('\n')}`
              : 'No reminders due right now.',
            data: due,
          };
        }

        case 'cancel': {
          const reminderId = params['reminderId'] as string | undefined;
          if (!reminderId?.trim()) return { success: false, output: 'reminderId is required.' };
          const idx = reminders.findIndex(r => r.id === reminderId);
          if (idx === -1) return { success: false, output: `Reminder not found: ${reminderId}` };
          reminders[idx]!.status = 'cancelled';
          saveReminders(reminders);
          return { success: true, output: `Reminder cancelled: "${reminders[idx]!.title}"` };
        }

        case 'stats': {
          const pending = reminders.filter(r => r.status === 'pending').length;
          const fired = reminders.filter(r => r.status === 'fired').length;
          return { success: true, output: `Reminders: ${pending} pending | ${fired} fired | ${reminders.length} total`, data: { pending, fired, total: reminders.length } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'personal.reminder-system error');
      return { success: false, output: `Reminder system error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// personal.email-manager
// ---------------------------------------------------------------------------

const emailManagerTool: ToolDefinition = {
  name: 'personal.email-manager',
  description:
    'AI-powered email inbox manager. Triage emails by priority, generate reply drafts, summarise threads, and create action items from email content.',
  category: 'personal',
  timeout: 90_000,
  parameters: {
    action: { type: 'string', required: true, description: 'Email management action.', enum: ['triage', 'draft-reply', 'summarise', 'extract-actions', 'compose'] },
    emails: { type: 'string', description: 'Email content(s) to process. Paste raw email text or a list of subject+body pairs.' },
    emailContent: { type: 'string', description: 'Single email content for draft-reply, summarise, or extract-actions.' },
    senderContext: { type: 'string', description: 'Context about the sender (role, relationship, company).' },
    replyIntent: { type: 'string', description: 'Your intended reply direction for draft-reply (e.g. "decline politely", "agree and ask for details").' },
    tone: { type: 'string', description: 'Tone for compose/draft-reply.', enum: ['formal', 'professional', 'friendly', 'brief'], default: 'professional' },
    to: { type: 'string', description: 'Recipient for compose action.' },
    subject: { type: 'string', description: 'Subject for compose action.' },
    intent: { type: 'string', description: 'What you want to communicate for compose action.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'personal.email-manager invoked');

    try {
      const system = 'You are a highly efficient executive assistant managing emails. Be concise, professional, and action-oriented.';

      switch (action) {
        case 'triage': {
          const emails = params['emails'] as string | undefined;
          if (!emails?.trim()) return { success: false, output: 'emails content is required for triage.' };
          const prompt = `Triage these emails and categorise each:

${emails}

For each email, output:
PRIORITY: [URGENT/HIGH/MEDIUM/LOW]
CATEGORY: [ACTION/FYI/WAITING/SPAM/NEWSLETTER]
SUMMARY: (one line)
ACTION: (what needs to be done, if anything)
DEADLINE: (if any)

End with a RECOMMENDED ORDER to process them.`;
          const output = await askBrain(ctx, system, prompt);
          return { success: true, output, data: { action, emailCount: emails.split('\n\n').length } };
        }

        case 'draft-reply': {
          const emailContent = params['emailContent'] as string | undefined;
          const replyIntent = (params['replyIntent'] as string | undefined) ?? 'respond appropriately';
          const tone = (params['tone'] as string | undefined) ?? 'professional';
          if (!emailContent?.trim()) return { success: false, output: 'emailContent is required for draft-reply.' };
          const prompt = `Draft a reply to this email:

${emailContent}

Reply intent: ${replyIntent}
Tone: ${tone}
${params['senderContext'] ? `Sender context: ${params['senderContext']}` : ''}

Write ONLY the email body (no subject line). Be ${tone}, concise, and professional. End with an appropriate sign-off.`;
          const output = await askBrain(ctx, system, prompt);
          return { success: true, output, data: { action, replyIntent, tone } };
        }

        case 'summarise': {
          const emailContent = params['emailContent'] as string | undefined;
          if (!emailContent?.trim()) return { success: false, output: 'emailContent is required for summarise.' };
          const prompt = `Summarise this email thread concisely:

${emailContent}

Provide:
SUMMARY: (2-3 sentences)
KEY POINTS: (bullet list)
DECISIONS MADE: (if any)
OPEN QUESTIONS: (if any)
NEXT STEPS: (if any)`;
          const output = await askBrain(ctx, system, prompt);
          return { success: true, output, data: { action } };
        }

        case 'extract-actions': {
          const emailContent = params['emailContent'] as string | undefined;
          if (!emailContent?.trim()) return { success: false, output: 'emailContent is required for extract-actions.' };
          const prompt = `Extract all action items from this email:

${emailContent}

List each action item as:
- WHO: [person responsible]
- WHAT: [specific task]
- DEADLINE: [date or "ASAP" or "no deadline"]
- PRIORITY: [HIGH/MEDIUM/LOW]

Then list any FOLLOW-UPS needed from you.`;
          const output = await askBrain(ctx, system, prompt);
          return { success: true, output, data: { action } };
        }

        case 'compose': {
          const to = params['to'] as string | undefined;
          const subject = params['subject'] as string | undefined;
          const intent = params['intent'] as string | undefined;
          const tone = (params['tone'] as string | undefined) ?? 'professional';
          if (!intent?.trim()) return { success: false, output: 'intent is required for compose.' };
          const prompt = `Compose an email with these details:
To: ${to ?? '[recipient]'}
Subject: ${subject ?? '[to be determined]'}
Intent: ${intent}
Tone: ${tone}
${params['senderContext'] ? `Context: ${params['senderContext']}` : ''}

Write the complete email including Subject: line, greeting, body, and sign-off. Be ${tone} and clear.`;
          const output = await askBrain(ctx, system, prompt);
          return { success: true, output, data: { action, to, subject, tone } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'personal.email-manager error');
      return { success: false, output: `Email manager error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const PERSONAL_TOOLS: ToolDefinition[] = [
  taskInboxTool,
  calendarManagerTool,
  reminderSystemTool,
  emailManagerTool,
];

/**
 * Register all personal productivity tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerPersonalTools(registry: ToolRegistry): void {
  logger.info({ count: PERSONAL_TOOLS.length }, 'Registering personal tools');
  for (const tool of PERSONAL_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: PERSONAL_TOOLS.length }, 'Personal tools registered');
}

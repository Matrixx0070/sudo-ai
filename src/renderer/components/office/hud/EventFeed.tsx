import React, { useEffect, useRef } from 'react';
import { useOfficeStore } from '@renderer/stores/officeStore.js';
import type { OfficeEventType } from '../types.js';

const MAX_VISIBLE = 15;

const EVENT_ICONS: Record<OfficeEventType, string> = {
  'agent-state-change': '⚡',
  'task-assigned': '📋',
  'task-completed': '✅',
  'agent-moved': '🚶',
  'agent-chat': '💬',
  'agent-error': '🐛',
  'agent-break': '☕',
  'meeting-started': '🤝',
  'meeting-ended': '👋',
  'system-alert': '🔔',
};

const EVENT_COLOR_CLASSES: Record<OfficeEventType, string> = {
  'agent-state-change': 'text-blue-400',
  'task-assigned': 'text-yellow-400',
  'task-completed': 'text-green-400',
  'agent-moved': 'text-teal-400',
  'agent-chat': 'text-blue-300',
  'agent-error': 'text-red-400',
  'agent-break': 'text-purple-400',
  'meeting-started': 'text-green-300',
  'meeting-ended': 'text-gray-400',
  'system-alert': 'text-yellow-300',
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function EventFeed(): React.ReactElement {
  const events = useOfficeStore((s) => s.events);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = events.slice(0, MAX_VISIBLE);

  // Auto-scroll to top whenever a new event arrives (newest first)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events]);

  return (
    <section
      className="event-feed-left"
      aria-label="Office live event feed"
      aria-live="polite"
      aria-atomic="false"
    >
      {/* Header */}
      <div className="event-feed-left__header">
        <span className="event-feed-left__dot" aria-hidden="true" />
        <h3 className="event-feed-left__title">Live Events</h3>
        <span className="event-feed-left__count">{events.length} total</span>
      </div>

      {/* Scrollable event list */}
      <div
        ref={scrollRef}
        className="event-feed-left__scroll"
        role="log"
      >
        {visible.length === 0 ? (
          <p className="event-feed-left__empty">No events yet — drama pending...</p>
        ) : (
          <ul className="event-feed-left__list">
            {visible.map((event) => (
              <li key={event.id} className="event-feed-left__item">
                <span
                  className="event-feed-left__icon"
                  aria-hidden="true"
                >
                  {EVENT_ICONS[event.type]}
                </span>
                <div className="event-feed-left__body">
                  <p
                    className={`event-feed-left__message ${EVENT_COLOR_CLASSES[event.type]}`}
                  >
                    {event.message}
                  </p>
                  <p className="event-feed-left__time">
                    {formatTime(event.timestamp)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default EventFeed;

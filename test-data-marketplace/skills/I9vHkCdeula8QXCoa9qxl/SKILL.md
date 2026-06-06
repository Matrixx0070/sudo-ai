---
name: calendar
description: Create, list, and manage Google Calendar events using OAuth authentication.
trigger: /calendar, schedule meeting, create event, check calendar, list events, add to calendar
allowed-tools: [comms.calendar-create, comms.calendar-list]
---

# Skill: Calendar

## Purpose
Manage Google Calendar: create new events, list upcoming events, and check availability
using the Google Calendar API with an OAuth access token.

## When to use
- User asks to schedule or create a calendar event
- User wants to see upcoming events or their schedule for a day/week
- User needs to check if a time slot is free
- User wants to add reminders or invites to a meeting

## How to use

1. Check that `GOOGLE_OAUTH_TOKEN` is available in the environment. If missing, inform the user and stop.

2. **Create an event:**
   - Extract title, date, time, duration, attendees, and location from `$ARGUMENTS` or ask.
   - Parse natural-language time ("tomorrow at 3pm") to ISO 8601 format.
   - Use `comms.calendar-create` with:
     ```json
     {
       "summary": "Meeting title",
       "start": { "dateTime": "2026-04-13T15:00:00", "timeZone": "Europe/London" },
       "end":   { "dateTime": "2026-04-13T16:00:00", "timeZone": "Europe/London" },
       "attendees": [{ "email": "alice@example.com" }],
       "description": "Optional notes",
       "location": "Optional location"
     }
     ```
   - Confirm with the returned event link.

3. **List upcoming events:**
   - Use `comms.calendar-list` with `{ maxResults: 10, timeMin: "<now ISO 8601>" }`.
   - Present a clean list: title, date/time, location (if set), attendees count.

4. **Check availability for a time slot:**
   - List events for the relevant day.
   - Report whether the slot is free or conflicts with existing events.

5. **All-day events:**
   - Use `{ "start": { "date": "2026-04-14" }, "end": { "date": "2026-04-15" } }` (no time).

## Requirements
- `GOOGLE_OAUTH_TOKEN` — valid Google OAuth2 access token with `calendar.events` scope.
- Default calendar is "primary" unless the user specifies another calendar ID.

## Example
```
/calendar create "Sprint planning" tomorrow 10am–11am with team@example.com
/calendar list next 7 days
/calendar create all-day "Company holiday" on 2026-04-25
```

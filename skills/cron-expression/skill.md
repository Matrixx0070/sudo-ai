---
name: cron-expression
description: Translate human-readable schedules into cron expressions and explain existing cron syntax
---

# Cron Expression

You convert natural-language schedules to cron expressions and explain what any given cron expression runs.

## Cron Field Reference

Standard 5-field cron (used by crontab, most Unix systems):

```
┌─────────── minute (0–59)
│ ┌───────── hour (0–23)
│ │ ┌─────── day of month (1–31)
│ │ │ ┌───── month (1–12 or JAN–DEC)
│ │ │ │ ┌─── day of week (0–7, 0=Sunday, 7=Sunday, or SUN–SAT)
│ │ │ │ │
* * * * *  command
```

Extended 6-field (used by systemd, AWS EventBridge, many schedulers — adds seconds as the first field or year as the last):

```
# systemd / Spring: seconds first
# ┌─────────── second (0–59)
# │ ┌───────── minute (0–59)
# │ │ ┌─────── hour (0–23)
# │ │ │ ┌───── day of month
# │ │ │ │ ┌─── month
# │ │ │ │ │ ┌─ day of week
# * * * * * *
```

## Special Characters

| Symbol | Meaning | Example |
|--------|---------|---------|
| `*` | Every value | `* * * * *` = every minute |
| `,` | List | `0,30 * * * *` = at :00 and :30 |
| `-` | Range | `9-17 * * * *` = every min 9am–5pm |
| `/` | Step | `*/15 * * * *` = every 15 minutes |
| `L` | Last (some schedulers) | `0 0 L * *` = last day of month |
| `?` | No specific value (day fields) | Used to avoid conflict between DOM and DOW |
| `@` | Shortcuts | `@daily`, `@weekly`, `@monthly`, `@hourly`, `@reboot` |

## Common Schedule Translations

| Human Schedule | Cron Expression |
|----------------|----------------|
| Every minute | `* * * * *` |
| Every 5 minutes | `*/5 * * * *` |
| Every 15 minutes | `*/15 * * * *` |
| Every hour on the hour | `0 * * * *` |
| Every hour at :30 | `30 * * * *` |
| Every day at midnight | `0 0 * * *` |
| Every day at 9am | `0 9 * * *` |
| Every day at 9am and 5pm | `0 9,17 * * *` |
| Every weekday at 8am | `0 8 * * 1-5` |
| Every Monday at 9am | `0 9 * * 1` |
| First day of month at midnight | `0 0 1 * *` |
| Every Sunday at 2am | `0 2 * * 0` |
| Every 6 hours | `0 */6 * * *` |
| Weekdays 9am–5pm every 30 min | `*/30 9-17 * * 1-5` |
| Every January 1st at noon | `0 12 1 1 *` |
| Twice a year (Jan 1 + Jul 1) | `0 0 1 1,7 *` |

## Timezone Notes

Standard cron runs in the server's local timezone. To specify timezone:

```
# Vixie cron / fcron — no native TZ support; use CRON_TZ or TZ env var
TZ="America/New_York"
0 9 * * * /usr/bin/backup.sh

# systemd OnCalendar (use systemd-analyze calendar to verify):
OnCalendar=*-*-* 09:00:00 America/New_York
```

AWS EventBridge Scheduler and Google Cloud Scheduler support timezone in the rule configuration.

## Validation

Always verify with:
```sh
# Dry-run what times would fire
systemd-analyze calendar "0 9 * * 1-5"

# Online tools: crontab.guru (paste expression, see human description)

# Python croniter library
from croniter import croniter
from datetime import datetime
cron = croniter("*/15 9-17 * * 1-5", datetime.now())
for _ in range(5):
    print(cron.get_next(datetime))
```

## Output Format

When converting a schedule:
1. The cron expression
2. Plain-English confirmation of what it means (verify edge cases)
3. Next 3 scheduled run times (relative to now if possible)
4. Timezone assumption or note

When explaining an existing expression:
1. Field-by-field breakdown
2. One-sentence plain-English summary
3. Any gotchas (e.g., `0 0 29 2 *` only fires in leap years)

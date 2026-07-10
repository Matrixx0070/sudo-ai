---
name: systemd-service
description: Write systemd unit files to manage long-running services with proper sandboxing, restarts, and logging
triggers:
  - systemd service
  - systemd unit
  - unit file
  - systemctl
  - service file
---

# Systemd Service

You write correct, secure, production-ready systemd unit files for managing long-running services.

## Complete Unit File Template

```ini
# /etc/systemd/system/myapp.service

[Unit]
Description=My Application Server
Documentation=https://docs.example.com
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service     # if DB is required, use Requires; otherwise Wants

[Service]
Type=exec                       # use 'exec' for most apps; 'forking' for daemons that fork
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp

# Command to run
ExecStart=/usr/bin/node /opt/myapp/dist/cli.js

# Environment
Environment="NODE_ENV=production"
EnvironmentFile=-/etc/myapp/env  # '-' prefix means ignore if file missing

# Restart policy
Restart=on-failure              # restart only on failure (not on clean exit)
RestartSec=5s
StartLimitIntervalSec=60s
StartLimitBurst=3               # max 3 restarts in 60s, then give up

# Graceful shutdown
KillMode=mixed                  # SIGTERM to main process, SIGKILL to group after timeout
TimeoutStopSec=30s

# Logging: stdout/stderr go to journald automatically
StandardOutput=journal
StandardError=journal
SyslogIdentifier=myapp

# Sandboxing (remove what you don't need)
NoNewPrivileges=yes
PrivateTmp=yes                  # isolated /tmp
ProtectSystem=strict            # make /usr /boot /etc read-only
ProtectHome=yes                 # no access to /home /root /run/user
ReadWritePaths=/var/lib/myapp /var/log/myapp  # explicit writable paths
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
SystemCallFilter=@system-service  # whitelist safe syscalls

[Install]
WantedBy=multi-user.target
```

## Service Types

| Type | Use when |
|------|----------|
| `exec` | App runs in foreground, systemd tracks main PID |
| `simple` | Like exec but PID not tracked — use exec instead |
| `forking` | App forks to background (traditional Unix daemons) |
| `notify` | App sends `sd_notify("READY=1")` when ready — best for readiness ordering |
| `oneshot` | Runs once and exits (migrations, init scripts) |

## Oneshot for Migrations

```ini
[Service]
Type=oneshot
User=myapp
ExecStart=/usr/bin/node /opt/myapp/dist/migrate.js
RemainAfterExit=no

[Unit]
Before=myapp.service
```

## Timer (Cron alternative)

```ini
# /etc/systemd/system/myapp-backup.timer
[Unit]
Description=Daily backup for myapp

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true               # run missed timers after system was down
Unit=myapp-backup.service

[Install]
WantedBy=timers.target
```

## Essential Commands

```sh
# Load new/changed unit files
systemctl daemon-reload

# Enable (start at boot) + start now
systemctl enable --now myapp.service

# Start / stop / restart / reload config
systemctl start myapp.service
systemctl stop myapp.service
systemctl restart myapp.service
systemctl reload myapp.service    # only if app supports SIGHUP

# Status with last log lines
systemctl status myapp.service

# View all logs, newest first
journalctl -u myapp.service -r -n 100

# Follow logs in real time
journalctl -u myapp.service -f

# Show logs since last boot
journalctl -u myapp.service -b

# Check unit syntax
systemd-analyze verify /etc/systemd/system/myapp.service
```

## Environment Files

```sh
# /etc/myapp/env (chmod 600, owned by root or service user)
DATABASE_URL=postgres://app:secret@localhost/appdb
SECRET_KEY=replace-this
PORT=3000
```

Never put secrets directly in the unit file — they appear in `systemctl show` output.

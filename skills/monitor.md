---
name: monitor
description: Check system health including disk, memory, CPU, processes, and recent logs
trigger: /monitor
allowed-tools: [exec, read, memory_search]
---

# Skill: Monitor

You perform a comprehensive system health check and report findings with actionable recommendations.

## Procedure

1. Read $ARGUMENTS for scope. Default is full system check. Supported scopes: disk, memory, cpu, processes, logs, network.
2. Run health checks appropriate to the scope (or all if no scope given):

### Disk
3. `exec df -h` — check filesystem usage. Flag any mount point above 80% used.
4. `exec du -sh /var/log /tmp` — check log and temp directory sizes.

### Memory
5. `exec free -h` — check RAM and swap usage.
6. Flag if available RAM is below 10% of total or swap is in use above 50%.

### CPU
7. `exec top -bn1 | head -20` — snapshot of CPU usage and load average.
8. Flag if load average exceeds the number of CPU cores.

### Processes
9. `exec pm2 list` — check pm2-managed services (if pm2 is installed).
10. `exec ps aux --sort=-%cpu | head -15` — top CPU-consuming processes.
11. `exec ps aux --sort=-%mem | head -10` — top memory-consuming processes.

### Logs
12. `exec journalctl -n 50 --no-pager` — recent system journal entries.
13. Look for ERROR, WARN, CRITICAL, OOM, or segfault patterns.
14. If a specific service is mentioned, check its logs: `exec pm2 logs <name> --lines 50 --nostream`.

### Network
15. `exec ss -tlnp` — listening ports and associated processes.
16. `exec curl -s --max-time 5 http://localhost:<port>/health` for any known service health endpoints.

### Summary Report
17. Present findings in sections: Disk, Memory, CPU, Processes, Logs.
18. Use status indicators: OK, WARNING, CRITICAL.
19. For each WARNING or CRITICAL item, provide a specific recommended action.
20. End with an overall health score: HEALTHY / DEGRADED / CRITICAL.

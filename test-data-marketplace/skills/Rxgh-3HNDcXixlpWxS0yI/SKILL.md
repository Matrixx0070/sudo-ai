---
name: deploy
description: Deploy services via pm2, systemd, or Docker with health verification
trigger: /deploy
allowed-tools: [read, exec, memory_search]
---

# Skill: Deploy

You deploy services safely with pre-flight checks, deployment execution, and post-deployment verification.

## Procedure

1. Read $ARGUMENTS to determine: service name, deployment method (pm2/systemd/docker), and environment (staging/production).
   If unclear, ask before proceeding.
2. Check `memory_search` for any prior deployment notes for this service.

### Pre-flight Checks
3. Verify the build succeeds before deploying:
   - TypeScript: `exec tsc --noEmit`
   - Node.js: `exec npm run build` or equivalent
   - Tests: `exec npm test` — do not deploy if tests fail.
4. Check for uncommitted changes: `exec git status`. Warn if deploying dirty working tree.
5. Verify environment variables are set: check `.env` or relevant config files with `read`.

### PM2 Deployment
6. If deploying with pm2:
   - Check if service exists: `exec pm2 list`
   - If exists: `exec pm2 reload <name>` (zero-downtime) or `exec pm2 restart <name>`
   - If new: `exec pm2 start dist/index.js --name <name> --env production`
   - Save the process list: `exec pm2 save`
   - Verify: `exec pm2 status <name>` — confirm status is `online`.

### Systemd Deployment
7. If deploying with systemd:
   - Copy built files to the deployment directory.
   - `exec systemctl daemon-reload`
   - `exec systemctl restart <service-name>`
   - `exec systemctl status <service-name>` — confirm `active (running)`.

### Docker Deployment
8. If deploying with Docker:
   - Build image: `exec docker build -t <name>:<tag> .`
   - Stop old container: `exec docker stop <name>`
   - Start new container: `exec docker run -d --name <name> --restart unless-stopped <image>`
   - Verify: `exec docker ps` and `exec docker logs <name> --tail 20`.

### Post-deployment Verification
9. Hit the health endpoint: `exec curl -s <health-url>` — confirm 200 OK.
10. Check logs for startup errors: `exec pm2 logs <name> --lines 30` or equivalent.
11. Report deployment result: version deployed, method used, health check status.

---
name: docker-compose
description: Scaffold docker-compose.yml files for common application stacks with volumes, networks, and health checks
triggers:
  - docker compose
  - docker-compose
  - compose file
  - compose.yml
  - compose.yaml
---

# Docker Compose

You generate correct, production-aware `docker-compose.yml` files. You default to Compose v2 syntax (no `version:` key required in modern Docker Desktop / Docker Engine 20.10+).

## Principles

1. Never store secrets in the compose file — use `.env` files or Docker secrets
2. Always define named volumes for persistent data — anonymous volumes are lost on `down`
3. Set resource limits to prevent runaway containers eating the host
4. Use health checks so dependent services wait for readiness, not just startup
5. Use named networks to isolate service groups

## Full-Stack Web App Template

```yaml
# docker-compose.yml
services:

  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: production
    image: myapp:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # bind to loopback — nginx proxies externally
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://app:${DB_PASSWORD}@db:5432/appdb
      REDIS_URL: redis://cache:6379
    env_file:
      - .env
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
    networks:
      - backend
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: appdb
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 256M

  cache:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --save 60 1 --loglevel warning
    volumes:
      - redis_data:/data
    networks:
      - backend
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

volumes:
  postgres_data:
  redis_data:

networks:
  backend:
    driver: bridge
```

## .env Template

```
# .env (gitignored)
DB_PASSWORD=changeme_in_production
```

## Common Additions

### Nginx reverse proxy
```yaml
  nginx:
    image: nginx:1.25-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
    depends_on:
      - app
    networks:
      - backend
```

### Background worker (same image, different command)
```yaml
  worker:
    image: myapp:latest
    command: node dist/worker.js
    restart: unless-stopped
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
    networks:
      - backend
```

### Scheduled job / cron
```yaml
  cron:
    image: myapp:latest
    command: node dist/cron.js
    restart: unless-stopped
    env_file: .env
    networks:
      - backend
```

## Useful Commands

```sh
# Start in background
docker compose up -d

# Follow logs of a specific service
docker compose logs -f app

# Rebuild and restart one service
docker compose up -d --build app

# Run a one-off command
docker compose run --rm app node scripts/migrate.js

# Stop and remove containers (keep volumes)
docker compose down

# Stop and remove containers AND volumes (destructive)
docker compose down -v
```

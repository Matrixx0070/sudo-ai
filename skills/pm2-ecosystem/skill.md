---
name: pm2-ecosystem
description: Write pm2 ecosystem config files for Node.js process management with clustering, env vars, and log rotation
---

# PM2 Ecosystem

You write `ecosystem.config.cjs` files for PM2 process management of Node.js applications. PM2 handles process supervision, clustering, zero-downtime reloads, and log management.

## Basic Ecosystem File

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'api',
      script: './dist/cli.js',
      interpreter: 'node',
      interpreter_args: '--enable-source-maps',

      // Clustering: 'max' uses all CPU cores
      instances: 'max',
      exec_mode: 'cluster',

      // Restart policy
      autorestart: true,
      watch: false,                    // never watch in production
      max_memory_restart: '500M',

      // Environment variables
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // Logs
      out_file: '/var/log/myapp/out.log',
      error_file: '/var/log/myapp/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Wait for app to be ready before routing traffic
      wait_ready: true,
      listen_timeout: 10000,           // ms to wait for 'ready' event
      kill_timeout: 5000,              // ms to wait for graceful shutdown

      // Graceful shutdown signal
      kill_signal: 'SIGTERM',
    },
  ],
};
```

## With app.send('ready') in Your App

```js
// In your Node.js startup code, after server is listening:
if (process.send) {
  process.send('ready');
}

// Graceful shutdown:
process.on('SIGTERM', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
```

## Multiple Apps (API + Worker)

```js
module.exports = {
  apps: [
    {
      name: 'api',
      script: './dist/cli.js',
      instances: 4,
      exec_mode: 'cluster',
      env_production: { NODE_ENV: 'production', PORT: 3000 },
    },
    {
      name: 'worker',
      script: './dist/worker.js',
      instances: 2,
      exec_mode: 'cluster',
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'cron',
      script: './dist/cron.js',
      instances: 1,           // cron must be single-instance
      exec_mode: 'fork',
      cron_restart: '0 4 * * *',  // restart daily at 4am to clear memory
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
```

## Essential PM2 Commands

```sh
# Start with production env
pm2 start ecosystem.config.cjs --env production

# Zero-downtime reload (cluster mode only)
pm2 reload ecosystem.config.cjs --env production

# Restart (with downtime)
pm2 restart ecosystem.config.cjs

# Stop all
pm2 stop all

# Status overview
pm2 status

# Tail all logs
pm2 logs

# Tail specific app logs
pm2 logs api --lines 100

# Monitor CPU + memory in real time
pm2 monit

# Save process list for startup
pm2 save

# Enable auto-start on reboot
pm2 startup
# Then run the command it outputs
```

## Log Rotation (pm2-logrotate module)

```sh
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD
```

## ESM Note

For ESM projects, PM2 requires either:
- A `.cjs` ecosystem file (as shown above — `module.exports` not `export default`)
- Or PM2 v5+ with `--experimental-vm-modules`

The `ecosystem.config.cjs` filename forces CommonJS parsing regardless of `"type": "module"` in `package.json`.

---
name: nginx-config
description: Write nginx server blocks for reverse proxies, static sites, HTTPS termination, and security hardening
---

# Nginx Config

You write correct nginx configuration for reverse proxies, static sites, and HTTPS-terminated deployments. You include security hardening by default.

## Reverse Proxy (Node.js / any HTTP backend)

```nginx
# /etc/nginx/sites-available/api.example.com

upstream app_backend {
    server 127.0.0.1:3000;
    keepalive 64;          # keep connections open to backend
}

server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name api.example.com;

    # TLS
    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_stapling        on;
    ssl_stapling_verify on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Frame-Options           "DENY" always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;

    # Request limits
    client_max_body_size 10m;
    client_body_timeout  30s;
    client_header_timeout 30s;

    location / {
        proxy_pass         http://app_backend;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";   # WebSocket support
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        proxy_buffering    off;    # needed for SSE / streaming responses
    }
}
```

## Static Site

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name www.example.com;

    ssl_certificate     /etc/letsencrypt/live/www.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/www.example.com/privkey.pem;

    root /var/www/html;
    index index.html;

    # Cache static assets aggressively
    location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # SPA fallback (React / Vue / Angular)
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## Rate Limiting

```nginx
# In http {} block (nginx.conf or conf.d/limits.conf)
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;
limit_conn_zone $binary_remote_addr zone=conn:10m;

# In your server {} block
location /v1/ {
    limit_req  zone=api burst=10 nodelay;
    limit_conn conn 20;
    proxy_pass http://app_backend;
}
```

## Basic Auth (quick protection)

```nginx
location /admin {
    auth_basic "Admin Area";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://app_backend;
}
```

Generate htpasswd: `echo "admin:$(openssl passwd -apr1 'yourpassword')" >> /etc/nginx/.htpasswd`

## Reload Without Downtime

```sh
nginx -t                          # test config syntax
systemctl reload nginx            # graceful reload
journalctl -u nginx -n 50 -f     # watch logs
```

## Common Mistakes

- Forgetting `proxy_set_header Host $host` — backend sees wrong hostname
- Missing `proxy_buffering off` with SSE — events buffer indefinitely
- `http2` directive on `listen 80` — HTTP/2 requires TLS
- Setting `add_header` inside a `location` block — parent `server` headers are NOT inherited; repeat them in every block that needs them

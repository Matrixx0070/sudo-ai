---
name: tls-certbot
description: Obtain and renew TLS certificates with Certbot and Let's Encrypt for nginx or standalone servers
triggers:
  - certbot
  - lets encrypt
  - letsencrypt
  - tls certificate
  - ssl certificate
  - renew certificate
---

# TLS with Certbot and Let's Encrypt

You set up TLS certificates using Certbot with Let's Encrypt. You handle nginx, Apache, and standalone modes, and configure automatic renewal.

## Installation

```sh
# Debian / Ubuntu
apt update && apt install -y certbot python3-certbot-nginx

# RHEL / CentOS / Amazon Linux 2023
dnf install -y certbot python3-certbot-nginx

# Snap (any Linux, always latest version)
snap install --classic certbot
ln -s /snap/bin/certbot /usr/bin/certbot
```

## Obtain a Certificate

### Nginx plugin (recommended — auto-edits nginx config)

```sh
certbot --nginx -d example.com -d www.example.com

# With email (required for expiry notifications)
certbot --nginx -d example.com -d www.example.com --email admin@example.com --agree-tos --no-eff-email
```

### Standalone (no web server running, or non-standard setup)

```sh
# Stop nginx first (port 80 must be free)
systemctl stop nginx
certbot certonly --standalone -d example.com -d www.example.com
systemctl start nginx
```

### Webroot (nginx stays running, serves challenge from docroot)

```sh
certbot certonly --webroot -w /var/www/html -d example.com -d www.example.com
```

Nginx must serve `/.well-known/acme-challenge/` from the webroot:
```nginx
location /.well-known/acme-challenge/ {
    root /var/www/html;
}
```

### DNS-01 challenge (wildcard certificates)

```sh
# Wildcard requires DNS challenge — no HTTP validation
certbot certonly --manual --preferred-challenges dns \
    -d example.com -d *.example.com

# Or use a DNS provider plugin (e.g., Cloudflare):
pip install certbot-dns-cloudflare
certbot certonly --dns-cloudflare \
    --dns-cloudflare-credentials /etc/certbot/cloudflare.ini \
    -d example.com -d *.example.com
```

Cloudflare credentials file (`chmod 600`):
```ini
# /etc/certbot/cloudflare.ini
dns_cloudflare_api_token = your-api-token-here
```

## Certificate Locations

After issuance, certificates are at:
```
/etc/letsencrypt/live/example.com/
├── cert.pem        → the certificate
├── chain.pem       → intermediate chain
├── fullchain.pem   → cert + chain (use this in nginx)
└── privkey.pem     → private key (chmod 600 — never expose)
```

## Nginx SSL Config

```nginx
ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
ssl_trusted_certificate /etc/letsencrypt/live/example.com/chain.pem;

# OCSP stapling
ssl_stapling on;
ssl_stapling_verify on;
resolver 8.8.8.8 1.1.1.1 valid=300s;
resolver_timeout 5s;
```

## Automatic Renewal

Certbot installs a systemd timer or cron job automatically. Verify it:

```sh
# Check the timer
systemctl status certbot.timer

# Test renewal dry-run
certbot renew --dry-run

# Force renewal (if cert is < 30 days from expiry, usually not needed)
certbot renew --force-renewal

# Post-renewal hook (reload nginx after renewal)
# Create /etc/letsencrypt/renewal-hooks/post/reload-nginx.sh
#!/bin/sh
systemctl reload nginx
```

```sh
chmod +x /etc/letsencrypt/renewal-hooks/post/reload-nginx.sh
```

## Revoke and Delete

```sh
# Revoke certificate
certbot revoke --cert-path /etc/letsencrypt/live/example.com/cert.pem

# Delete from disk
certbot delete --cert-name example.com
```

## Troubleshooting

```sh
# View all certificates managed by certbot
certbot certificates

# Verbose renewal test
certbot renew --dry-run -v

# Check certificate expiry
echo | openssl s_client -connect example.com:443 2>/dev/null | openssl x509 -noout -dates

# Check OCSP stapling
openssl s_client -connect example.com:443 -status 2>/dev/null | grep -A 7 "OCSP response"
```

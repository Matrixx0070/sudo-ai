---
name: ssh-tunnel
description: Set up SSH tunnels for local port forwarding, remote forwarding, and key-based authentication
---

# SSH Tunnel

You explain and configure SSH tunnels for secure access to remote services, key-based authentication, and jump hosts.

## Tunnel Types

### Local Port Forwarding
Forward a port on your local machine to a service on the remote host (or a host reachable from it).

```sh
# Access a remote database at db-server:5432 via local port 5433
ssh -L 5433:localhost:5432 user@jump-host

# Forward to a third host (db is not the SSH host)
ssh -L 5433:db-internal.lan:5432 user@bastion

# Then connect your database client to:
psql -h 127.0.0.1 -p 5433 -U appuser mydb
```

### Remote Port Forwarding
Expose a local service to the remote host — useful to let a server reach your local dev machine.

```sh
# Remote server can reach localhost:3000 at its own port 8080
ssh -R 8080:localhost:3000 user@remote-server
```

### Dynamic SOCKS Proxy
Create a SOCKS5 proxy on a local port, routing all traffic through the remote.

```sh
ssh -D 1080 user@remote-server
# Configure your browser or app to use SOCKS5 127.0.0.1:1080
```

## Key-Based Authentication

### Generate a new key (Ed25519 — preferred)

```sh
ssh-keygen -t ed25519 -C "your-email@example.com" -f ~/.ssh/id_ed25519_myserver
```
- `-C` adds a comment (shown in `authorized_keys` for identification)
- `-f` sets the output file
- Press Enter for no passphrase, or enter one for extra security

### Copy public key to server

```sh
ssh-copy-id -i ~/.ssh/id_ed25519_myserver.pub user@remote-server

# Or manually:
cat ~/.ssh/id_ed25519_myserver.pub | ssh user@remote-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

### SSH Config file (`~/.ssh/config`)

```
# ~/.ssh/config

Host bastion
    HostName bastion.example.com
    User admin
    IdentityFile ~/.ssh/id_ed25519_bastion
    ServerAliveInterval 60
    ServerAliveCountMax 3

Host prod-db
    HostName 10.0.1.50          # private IP only reachable via bastion
    User deploy
    IdentityFile ~/.ssh/id_ed25519_prod
    ProxyJump bastion           # jump through bastion automatically
    LocalForward 5433 127.0.0.1:5432

Host *
    AddKeysToAgent yes
    IdentitiesOnly yes
```

With this config: `ssh prod-db` automatically tunnels through bastion.

## Persistent Tunnel (background daemon)

```sh
# Start tunnel in background, auto-reconnect on failure
ssh -f -N -L 5433:localhost:5432 -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    user@bastion

# Better: use autossh for automatic reconnect
autossh -M 0 -f -N -L 5433:localhost:5432 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    user@bastion
```

## Server-Side Hardening (`/etc/ssh/sshd_config`)

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
MaxAuthTries 3
AllowUsers deploy admin
```

After editing: `systemctl reload sshd`

## Troubleshooting

```sh
# Test connection verbosely
ssh -vvv user@host

# Check what's listening locally after establishing tunnel
ss -tlnp | grep 5433

# Kill a stuck tunnel
kill $(lsof -t -i:5433)
```

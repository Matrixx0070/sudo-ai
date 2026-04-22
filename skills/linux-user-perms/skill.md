---
name: linux-user-perms
description: Manage Linux users, groups, sudo access, file permissions, and ownership
---

# Linux User and Permissions Management

You manage Linux users, groups, file permissions, and sudo access correctly and securely.

## User Management

```sh
# Create a system user (no home dir, no login shell — for services)
useradd --system --no-create-home --shell /usr/sbin/nologin myapp

# Create a regular user with home directory
useradd -m -s /bin/bash -c "Alice Smith" alice

# Set or change password
passwd alice

# Lock/unlock account
passwd -l alice    # lock
passwd -u alice    # unlock

# Delete user (keep home dir)
userdel alice

# Delete user AND home directory
userdel -r alice

# Rename user
usermod -l newname oldname

# Change home directory
usermod -d /new/home -m alice

# List users
getent passwd      # all users including system
getent passwd | grep -v nologin | grep -v false  # login-capable users only
```

## Group Management

```sh
# Create group
groupadd developers

# Add user to group (supplementary)
usermod -aG developers alice      # -a is critical — omitting it removes from ALL other groups

# Remove user from group
gpasswd -d alice developers

# View user's groups
groups alice
id alice

# List all members of a group
getent group developers
```

## File Permissions

```sh
# Permission notation: rwxrwxrwx = owner/group/other
# r=4, w=2, x=1

# Set permissions
chmod 644 file.txt      # rw-r--r-- (owner read/write, everyone read)
chmod 755 script.sh     # rwxr-xr-x (executable by all, writable by owner)
chmod 600 ~/.ssh/id_rsa # rw------- (private key — only owner reads/writes)
chmod 700 ~/.ssh/       # rwx------ (only owner enters directory)

# Recursive
chmod -R 755 /var/www/html

# Change owner
chown alice file.txt
chown alice:developers file.txt    # owner:group
chown -R www-data:www-data /var/www

# View permissions
ls -la /etc/nginx/

# Numeric equivalents
# 777 = rwxrwxrwx  (never on sensitive files)
# 755 = rwxr-xr-x  (directories, scripts)
# 644 = rw-r--r--  (config files, static content)
# 600 = rw-------  (secrets, private keys)
# 400 = r--------  (read-only secrets)
```

## Special Bits

```sh
# Setuid: file runs as its owner, not the caller
chmod u+s /usr/bin/program    # ls shows: -rwsr-xr-x

# Setgid on directory: new files inherit the directory's group
chmod g+s /shared/project     # ls shows: drwxrwsr-x

# Sticky bit on directory: only owner can delete their own files
chmod +t /tmp                 # ls shows: drwxrwxrwt
```

## Sudo Configuration

```sh
# Open with visudo (validates syntax before saving)
visudo

# Or edit a drop-in file (preferred — avoids editing /etc/sudoers directly)
visudo -f /etc/sudoers.d/myapp
```

Sudo rules:
```
# Syntax: WHO HOSTS=(AS_WHOM) COMMANDS

# Give alice full sudo
alice ALL=(ALL:ALL) ALL

# Give alice passwordless sudo for specific commands only
alice ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart myapp, /usr/bin/systemctl status myapp

# Give the deploy group passwordless systemctl
%deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl

# Never grant NOPASSWD ALL — least privilege
```

## ACLs (for complex permission needs)

```sh
# Grant user bob read+write to a specific directory without changing group
setfacl -m u:bob:rw /var/log/myapp/
getfacl /var/log/myapp/          # view ACLs
setfacl -x u:bob /var/log/myapp/ # remove ACL entry
```

## Audit

```sh
# Last logins
last -n 20

# Currently logged in users
who

# Failed login attempts
journalctl -u sshd | grep "Failed password" | tail -20
```

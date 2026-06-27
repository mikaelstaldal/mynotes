# MyNotes — Operations Guide

This guide covers production installation of MyNotes on a Linux server, including TLS termination via a reverse proxy (e.g. nginx) and systemd service management.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Install the Binary](#install-the-binary)
3. [Create a System User](#create-a-system-user)
4. [Set Up the Data Directory](#set-up-the-data-directory)
5. [Set Up Authentication](#set-up-authentication)
6. [Configure systemd](#configure-systemd)
7. [Configure a Reverse Proxy](#configure-a-reverse-proxy)
8. [First Login](#first-login)
9. [Upgrading](#upgrading)

---

## Prerequisites

- A Linux server.
- nginx (or another reverse proxy capable of TLS termination).
- A valid TLS certificate for your domain (e.g. from Let's Encrypt).
- Go 1.26+, `ogen`, `tsc`, and `openapi-typescript` if building from source; otherwise download a pre-built binary.

---

## Install the Binary

### Build from source

```bash
git clone https://github.com/mikaelstaldal/mynotes.git
cd mynotes
./build.sh
install -o root -g root -m 0755 mynotes /usr/local/bin/mynotes
```

---

## Create a System User

Run MyNotes as a dedicated non-root user.

```bash
useradd --system --home-dir /var/lib/mynotes --shell /usr/sbin/nologin mynotes
```

---

## Set Up the Data Directory

```bash
mkdir -p /var/lib/mynotes
chown mynotes:mynotes /var/lib/mynotes
chmod 0700 /var/lib/mynotes
```

MyNotes creates `mynotes.sqlite` in the data directory on first startup and applies schema migrations automatically on each subsequent start.

---

## Set Up Authentication

MyNotes uses HTTP Basic Auth backed by an htpasswd file (bcrypt). Create the file as the `mynotes` user:

```bash
mkdir -p /etc/mynotes
htpasswd -Bc /etc/mynotes/htpasswd myuser
```

Protect the file:

```bash
chown mynotes:mynotes /etc/mynotes/htpasswd
chmod 0600 /etc/mynotes/htpasswd
```

> **Important:** HTTP Basic Auth must only be used over HTTPS. Never expose MyNotes on a non-loopback interface without TLS. The reverse proxy (see below) provides TLS termination.

---

## Configure systemd

Create `/etc/systemd/system/mynotes.service`:

```ini
[Unit]
Description=MyNotes note-taking application
After=network.target

[Service]
Type=exec
User=mynotes
Group=mynotes

LoadCredential=basic-auth:/etc/mynotes/htpasswd

ExecStart=/usr/local/bin/mynotes \
    -data /var/lib/mynotes \
    -addr 127.0.0.1 \
    -port 8080 \
    -public-url https://notes.example.com \
    -basic-auth-file ${CREDENTIALS_DIRECTORY}/basic-auth

Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/mynotes

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable mynotes
systemctl start mynotes
systemctl status mynotes
```

View logs:

```bash
journalctl -u mynotes -f
```

---

## Configure a Reverse Proxy

MyNotes does not terminate TLS itself. Place it behind a reverse proxy.

Start MyNotes with `-public-url https://notes.example.com` (an `https://` URL also enables `Strict-Transport-Security`). The CSRF middleware rejects state-changing requests whose `Origin` or `Referer` does not match the configured public URL.

One requirement regardless of which reverse proxy you use:

- **Rate limiting** — MyNotes has no built-in rate limiting. The reverse proxy must enforce a per-IP request rate limit to prevent DoS via bulk note creation or repeated queries.

### nginx

Create `/etc/nginx/sites-available/mynotes`:

```nginx
server {
    listen 80;
    server_name notes.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name notes.example.com;

    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    # Modern TLS settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # Rate limiting (adjust as needed)
    limit_req_zone $binary_remote_addr zone=mynotes:10m rate=10r/s;
    limit_req zone=mynotes burst=20 nodelay;

    location / {
        proxy_pass http://127.0.0.1:8080;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and test:

```bash
ln -s /etc/nginx/sites-available/mynotes /etc/nginx/sites-enabled/mynotes
nginx -t
systemctl reload nginx
```

#### TLS certificate (Let's Encrypt)

```bash
certbot --nginx -d notes.example.com
```

Certbot will modify the nginx config to handle certificate renewal automatically.

### Apache 2

Requires `mod_proxy`, `mod_proxy_http`, `mod_ratelimit`, `mod_ssl`, and `mod_headers`. Enable them with:

```bash
a2enmod proxy proxy_http ratelimit ssl headers
```

```apache
<VirtualHost *:443>
    ServerName notes.example.com

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/notes.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/notes.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/

    RequestHeader set X-Forwarded-Proto "https"

    # Rate limiting: 10 requests/second per connection
    <Location />
        SetOutputFilter RATE_LIMIT
        SetEnv rate-limit 10
    </Location>
</VirtualHost>

# Redirect HTTP to HTTPS
<VirtualHost *:80>
    ServerName notes.example.com
    Redirect permanent / https://notes.example.com/
</VirtualHost>
```

> **Note:** Apache's `mod_ratelimit` limits the *response* throughput (bytes/sec), not the request rate. For true per-IP request-rate limiting use `mod_qos` (available as a package on most distributions: `apt install libapache2-mod-qos`) and add `QS_SrvMaxConnPerIP 10` to the VirtualHost block.

### Caddy

```caddy
notes.example.com {
    # Rate limiting (requires caddy-ratelimit module)
    rate_limit {remote.ip} 10r/s

    reverse_proxy 127.0.0.1:8080
}
```

> **Note:** The built-in Caddy distribution does not include a rate-limiting module. Build Caddy with `xcaddy build --with github.com/mholt/caddy-ratelimit`, or use nginx if you prefer not to build a custom binary.

### Sub-path deployment

MyNotes can be deployed at a URL sub-path (e.g. `https://example.com/mynotes`). Pass the full path in `-public-url`:

```
-public-url https://example.com/mynotes
```

MyNotes rewrites the `<base href>` in the HTML shell automatically; the reverse proxy must strip the prefix before forwarding:

```nginx
location /mynotes/ {
    proxy_pass http://127.0.0.1:8080/;
    # ... other proxy_set_header directives as above
}
```

---

## First Login

Open `https://notes.example.com` in your browser. Log in with the username and password you set in the htpasswd file.

---

## Upgrading

1. Build or download the new binary.
2. Stop the service:
   ```bash
   systemctl stop mynotes
   ```
3. Replace the binary:
   ```bash
   install -o root -g root -m 0755 mynotes-new /usr/local/bin/mynotes
   ```
4. Start the service — schema migrations are applied automatically on startup:
   ```bash
   systemctl start mynotes
   ```
5. Check the logs for any migration or startup errors:
   ```bash
   journalctl -u mynotes -n 50
   ```

---

## Firewall

MyNotes binds to `127.0.0.1` by default and is never directly exposed to the internet. Ensure your firewall allows:

| Port | Protocol | Purpose                                  |
|------|----------|------------------------------------------|
| 80   | TCP      | HTTP → redirect to HTTPS (reverse-proxy) |
| 443  | TCP      | HTTPS (reverse-proxy → MyNotes)          |

The MyNotes process itself (port 8080) must not be reachable from outside the server.

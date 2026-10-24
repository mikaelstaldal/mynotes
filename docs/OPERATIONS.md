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
htpasswd -B -C 10 -c /etc/mynotes/htpasswd myuser
```

Set an explicit bcrypt cost (`-C 10` in this example) and test authentication latency on your server.
Higher costs slow password guessing but also increase CPU use on every Basic-authenticated request; configure
external request limits as described below. See the
[htpasswd options](https://httpd.apache.org/docs/2.4/programs/htpasswd.html).
Omit `-c` when updating an existing file, since it overwrites the file.

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

Start MyNotes with `-public-url https://notes.example.com` (an `https://` URL also enables `Strict-Transport-Security`). The Host allowlist applies to every route, including published pages and demo mode, and rejects foreign or malformed authorities with HTTP 421 before authentication. The proxy must preserve the public Host or send an allowed local Host with the listener port; forwarding headers do not authorize a Host. Wildcard binds (`0.0.0.0`, `::`, or an empty address) require `-public-url`.

CSRF accepts the public URL origin (ignoring any deployment path), plus HTTP origins for `localhost`, `127.0.0.1`, `[::1]`, and a concrete bind address at the listener port. Browser writes from other origins receive 403; native requests without Origin or Referer remain accepted. These local origins are trusted even behind a proxy: avoid running untrusted local services at that port on another interface.

### Rate limiting and authentication abuse

Configure request-rate limiting in the reverse proxy or an upstream firewall before requests reach MyNotes.
MyNotes has no built-in throttling or lockout for Basic authentication, or cap on concurrent bcrypt comparisons.
With `-basic-auth-file`, requests to Basic-protected routes carrying parseable credentials can trigger an expensive
bcrypt comparison, including unknown usernames and wrong passwords. A flood can exhaust CPU, and repeated password
attempts are not limited by the application. Use strong passwords as well as external rate limits.

Apply per-client limits to all paths and methods, including GET requests, static assets, and failed authentication
attempts, rather than only writes or a login endpoint. Add an aggregate request limit sized for the server's CPU
capacity so requests from many IP addresses cannot bypass the per-client protection. Tune sustained rates and
bursts under load with bcrypt enabled, allowing normal page loads, note editing and autosave, and API clients.
The nginx values below are starting points, not a capacity guarantee. The aggregate budget is shared by all
clients: when exhausted, it rejects requests even from clients below their individual limit. Size it for expected
concurrent users while preserving CPU headroom. The example allows bounded bursts immediately to avoid delaying
cold page loads with many module requests; those bursts can still cause CPU spikes. Test with an empty browser
cache as well as concurrent clients, and tune burst sizes as well as sustained rates.

Use the client address observed by the edge proxy for limiting and logging. If another trusted proxy sits in front,
configure client-IP handling to trust only that proxy; never accept arbitrary client-supplied forwarding headers.
For fail2ban-style blocking of repeated 401 responses, use the edge proxy's access log: behind a reverse proxy,
MyNotes' authentication log records the proxy's address as `RemoteAddr`. Failure-based blocking supplements
request limits; it does not prevent the bcrypt work needed to produce the initial 401 responses.

Keep the backend listener private so clients cannot bypass these controls (see [Firewall](#firewall)). A firewall
that only limits new TCP connections is insufficient on its own, since one persistent connection can carry many
HTTP requests. Use HTTP request limiting at the proxy or an HTTP-aware upstream firewall.

After deployment, verify in a controlled test that excessive requests with invalid Basic credentials are rejected
at the edge, that rejected requests do not reach MyNotes, and that legitimate clients remain usable. Monitor proxy
rejections, 401 responses, and backend CPU usage when tuning the limits.

### nginx

Create `/etc/nginx/sites-available/mynotes`, included from the `http` context of `/etc/nginx/nginx.conf`.
The zone definitions must be outside the `server` blocks, as required by
[nginx's request limiting module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).

```nginx
# Shared request-rate state; these directives belong in the http context.
limit_req_zone $binary_remote_addr zone=mynotes_per_ip:10m rate=5r/s;
limit_req_zone $server_name zone=mynotes_total:1m rate=10r/s;

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

    # Apply before forwarding any request to MyNotes; tune rates and bursts for your CPU.
    limit_req zone=mynotes_per_ip burst=100 nodelay;
    limit_req zone=mynotes_total burst=200 nodelay;
    limit_req_status 429;

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

Requires `mod_proxy`, `mod_proxy_http`, `mod_ssl`, and `mod_headers`. Enable them with:

```bash
a2enmod proxy proxy_http ssl headers
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
</VirtualHost>

# Redirect HTTP to HTTPS
<VirtualHost *:80>
    ServerName notes.example.com
    Redirect permanent / https://notes.example.com/
</VirtualHost>
```

The Apache configuration above provides TLS and proxying only. Add per-client and aggregate HTTP request limits
using a suitable request-limiting module or an upstream HTTP-aware firewall before exposing it publicly.
Apache's [mod_ratelimit](https://httpd.apache.org/docs/2.4/mod/mod_ratelimit.html) limits response bandwidth,
not request rates, and does not protect bcrypt verification. A per-IP connection cap alone is also insufficient.

### Caddy

```caddy
notes.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

The Caddy configuration above provides TLS and proxying only. Configure per-client and aggregate HTTP request
limits through a suitable third-party module or an upstream HTTP-aware firewall before exposing it publicly.
Alternatively, use the nginx request-limiting configuration above.

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

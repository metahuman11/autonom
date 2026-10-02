#!/usr/bin/env bash
# Installs / updates the Gateway service on the server. Run with sudo on the server
# from the uploaded bundle directory (see deploy/push.sh). Idempotent.
set -euo pipefail
APP_DIR=/opt/gateway
BUNDLE=${1:?bundle dir}
DOMAIN=${GATEWAY_DOMAIN:-autonom.fun}
PORT=${GATEWAY_PORT:-4750}
MEDIAMTX_VER=${MEDIAMTX_VER:-v1.21.0}

id -u gateway >/dev/null 2>&1 || useradd -r -m -d $APP_DIR -s /usr/sbin/nologin gateway
mkdir -p $APP_DIR/app $APP_DIR/agent $APP_DIR/data $APP_DIR/mediamtx
rsync -a --delete --exclude data --exclude node_modules --exclude .env "$BUNDLE/control-room/" $APP_DIR/app/
rsync -a "$BUNDLE/agent/" $APP_DIR/agent/
chown -R gateway:gateway $APP_DIR/app $APP_DIR/agent $APP_DIR/data $APP_DIR/mediamtx
chmod 700 $APP_DIR/data
( cd $APP_DIR/app && sudo -u gateway npm ci --omit=dev --silent )

# .env is created once; later runs keep it.
if [ ! -f $APP_DIR/app/.env ]; then
  install -o gateway -g gateway -m 600 "$BUNDLE/env.server" $APP_DIR/app/.env
fi

# MediaMTX
if [ ! -x $APP_DIR/mediamtx/mediamtx ] || ! $APP_DIR/mediamtx/mediamtx --version 2>/dev/null | grep -q "$MEDIAMTX_VER"; then
  curl -fsSL -o /tmp/mediamtx.tgz "https://github.com/bluenviron/mediamtx/releases/download/$MEDIAMTX_VER/mediamtx_${MEDIAMTX_VER}_linux_amd64.tar.gz"
  tar -xzf /tmp/mediamtx.tgz -C $APP_DIR/mediamtx mediamtx
  chown gateway:gateway $APP_DIR/mediamtx/mediamtx
fi
PUBLIC_IP=${GATEWAY_PUBLIC_IP:-$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}
# MediaMTX is only restarted when its config or binary actually changed: a restart
# drops every live RTMP publisher and the channels show "not streaming" for ~20 s.
MTX_BEFORE=$(cat $APP_DIR/mediamtx/mediamtx.yml $APP_DIR/mediamtx/mediamtx 2>/dev/null | sha256sum | cut -c1-16)
sed -e "s/__PORT__/$PORT/g" -e "s/__PUBLIC_IP__/$PUBLIC_IP/g" $APP_DIR/app/deploy/mediamtx.yml > $APP_DIR/mediamtx/mediamtx.yml
chown gateway:gateway $APP_DIR/mediamtx/mediamtx.yml
MTX_AFTER=$(cat $APP_DIR/mediamtx/mediamtx.yml $APP_DIR/mediamtx/mediamtx 2>/dev/null | sha256sum | cut -c1-16)

cat > /etc/systemd/system/gateway.service <<EOF
[Unit]
Description=Gateway launchpad (control room + site API)
After=network-online.target
[Service]
User=gateway
WorkingDirectory=$APP_DIR/app
Environment=PORT=$PORT
Environment=CONTROL_ROOM_DATA_DIR=$APP_DIR/data
ExecStart=/usr/bin/node src/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR/data
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/gateway-mediamtx.service <<EOF
[Unit]
Description=Gateway MediaMTX (RTMP in, HLS out)
After=network-online.target gateway.service
[Service]
User=gateway
WorkingDirectory=$APP_DIR/mediamtx
ExecStart=$APP_DIR/mediamtx/mediamtx $APP_DIR/mediamtx/mediamtx.yml
Restart=always
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now gateway gateway-mediamtx >/dev/null
systemctl restart gateway
if [ "$MTX_BEFORE" != "$MTX_AFTER" ] || ! systemctl is-active --quiet gateway-mediamtx; then systemctl restart gateway-mediamtx; echo "mediamtx restarted (config/binary changed)"; else echo "mediamtx untouched (streams kept)"; fi

# nginx: HTTP first (ACME), then HTTPS once a certificate exists.
mkdir -p /var/www/certbot
cat > /etc/nginx/sites-available/$DOMAIN <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
nginx -t && systemctl reload nginx
if [ ! -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
  certbot certonly --webroot -w /var/www/certbot -d $DOMAIN --non-interactive --agree-tos --register-unsafely-without-email --quiet || echo "certbot failed (continuing without TLS block)"
fi
if [ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
cat >> /etc/nginx/sites-available/$DOMAIN <<EOF
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    client_max_body_size 2m;
    # HLS from MediaMTX
    # WHEP (WebRTC) signalling → MediaMTX; the Location header of a session is rewritten under /whep/.
    location /whep/ {
        proxy_pass http://127.0.0.1:8889/;
        proxy_redirect / /whep/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        add_header Access-Control-Allow-Origin * always;
    }
    location /hls/ {
        proxy_pass http://127.0.0.1:8888/;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_redirect / /hls/;
        add_header Cache-Control "no-cache";
    }
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
    }
}
EOF
nginx -t && systemctl reload nginx
fi

ufw allow 1935/tcp >/dev/null 2>&1 || true
ufw allow 8189/udp >/dev/null 2>&1 || true   # WebRTC media
ufw allow 8189/tcp >/dev/null 2>&1 || true
echo "installed: https://$DOMAIN  (node on 127.0.0.1:$PORT, rtmp :1935, hls 127.0.0.1:8888)"
systemctl --no-pager --lines=0 status gateway gateway-mediamtx | grep -E "gateway|Active"

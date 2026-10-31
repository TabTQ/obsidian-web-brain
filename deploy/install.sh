#!/usr/bin/env bash
# Install or upgrade Brain inside the LXC. Run as root from the unpacked release directory.
# Idempotent: safe to re-run for upgrades.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE_MAJOR="${NODE_MAJOR:-24}"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils git openssh-client >/dev/null

echo "== node.js ${NODE_MAJOR}.x (official tarball, checksum verified)"
if ! /opt/node/bin/node -v 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  tmp=$(mktemp -d)
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -oE "node-v[0-9.]+-linux-x64\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi
/opt/node/bin/node -v

echo "== user and directories"
id brain >/dev/null 2>&1 || useradd --system --home-dir /var/lib/brain --shell /usr/sbin/nologin brain
install -d -o brain -g brain -m 0700 /var/lib/brain /var/lib/brain/vault

echo "== application"
rm -rf /opt/brain.new && mkdir -p /opt/brain.new
cp -r "$HERE/server" "$HERE/web" "$HERE/VERSION" /opt/brain.new/
rm -rf /opt/brain.old; [ -d /opt/brain ] && mv /opt/brain /opt/brain.old
mv /opt/brain.new /opt/brain
chown -R root:root /opt/brain && chmod -R a+rX /opt/brain

echo "== systemd"
install -m 0644 "$HERE/brain.service" /etc/systemd/system/brain.service
systemctl daemon-reload
systemctl enable brain >/dev/null
systemctl restart brain
systemctl --no-pager --lines=0 status brain | head -5
# Wait for the server to listen (startup runs a git sync first, which can take a few seconds).
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8090/api/v1/setup/status 2>/dev/null && echo && break; sleep 1; done
if [ -f /var/lib/brain/setup-code.txt ]; then
  echo "FIRST-RUN SETUP CODE: $(cat /var/lib/brain/setup-code.txt)"
fi
echo "Installed $(cat /opt/brain/VERSION)"

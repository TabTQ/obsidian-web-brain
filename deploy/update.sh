#!/usr/bin/env bash
# Upload the newest release to the Brain LXC and re-run the installer (keeps data).
# Required: PVE_HOST (ssh host of the Proxmox node), VMID (Brain container id).
#   PVE_HOST=root@my-pve VMID=200 bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PVE_HOST:?set PVE_HOST, the ssh target of the Proxmox node}"
: "${VMID:?set VMID, the Brain container id}"
TAR=$(ls -t release/brain-*.tar.gz | head -1)
echo "Deploying $TAR to CT $VMID via $PVE_HOST"
scp -q "$TAR" "$PVE_HOST:/tmp/brain.tar.gz"
ssh "$PVE_HOST" "pct push $VMID /tmp/brain.tar.gz /root/brain.tar.gz && rm /tmp/brain.tar.gz && pct exec $VMID -- bash -c 'cd /root && rm -rf brain && tar xzf brain.tar.gz && bash brain/install.sh'"

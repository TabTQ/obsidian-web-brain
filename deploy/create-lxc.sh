#!/usr/bin/env bash
# Create an unprivileged Debian 12 LXC for Brain on a Proxmox VE host (run as root on the node).
# Required: VMID, IP (CIDR), GW.  Optional: HOSTNAME_CT, TEMPLATE, STORAGE, BRIDGE, NAMESERVER.
#   VMID=200 IP=192.0.2.50/24 GW=192.0.2.1 bash create-lxc.sh
set -euo pipefail
: "${VMID:?set VMID (unused container id)}"
: "${IP:?set IP in CIDR form, e.g. 192.0.2.50/24}"
: "${GW:?set GW, the gateway address}"
HOSTNAME_CT="${HOSTNAME_CT:-brain}"
TEMPLATE="${TEMPLATE:-local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
NAMESERVER="${NAMESERVER:-1.1.1.1}"

if pct status "$VMID" >/dev/null 2>&1; then echo "CT $VMID already exists"; exit 1; fi
pct create "$VMID" "$TEMPLATE" \
  --hostname "$HOSTNAME_CT" --cores 2 --memory 1024 --swap 512 \
  --rootfs "$STORAGE:12" --unprivileged 1 --features nesting=1 \
  --net0 "name=eth0,bridge=$BRIDGE,firewall=1,gw=$GW,ip=$IP,type=veth" \
  --nameserver "$NAMESERVER" --onboot 1 --timezone host \
  --description "Brain: markdown vault web UI + shared-memory MCP (Tailscale-only access)"
# TUN device so Tailscale can run inside the container
cat >> "/etc/pve/lxc/$VMID.conf" <<CONF
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
CONF
pct start "$VMID"
sleep 5
pct exec "$VMID" -- bash -c "ls -l /dev/net/tun && ping -c1 -W2 1.1.1.1 >/dev/null && echo network-ok"

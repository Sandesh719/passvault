#!/usr/bin/env bash
#
# Prepare a fresh cloud VM to run the PassVault signaling server.
#
# Installs Docker and opens ports 80 and 443. That second part is the one that
# catches people on Oracle Cloud: their images ship with a local firewall that
# rejects everything except SSH, so opening the ports in the web console is only
# half the job and the other half fails silently — Let's Encrypt simply cannot
# reach the machine, and Caddy reports a timeout that looks like a DNS problem.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/passvault/main/deploy/provision.sh | sudo bash
#
# or, having cloned the repository:
#
#   sudo bash deploy/provision.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---- Docker ----------------------------------------------------------------

if command -v docker >/dev/null 2>&1; then
  say "Docker is already installed ($(docker --version))"
else
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

systemctl enable --now docker

# The user who invoked sudo, so they can run docker without it afterwards.
TARGET_USER="${SUDO_USER:-}"
if [[ -n "$TARGET_USER" && "$TARGET_USER" != "root" ]]; then
  usermod -aG docker "$TARGET_USER"
  echo "Added $TARGET_USER to the docker group — log out and back in for it to apply."
fi

# ---- Ports 80 and 443 ------------------------------------------------------

say "Opening ports 80 and 443"

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  # Oracle Linux, Rocky, Alma.
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
  echo "firewalld: http and https allowed"
else
  # Ubuntu on Oracle Cloud. The stock rules end with a blanket REJECT, so a rule
  # appended to the end of the chain never matches. These are inserted at the
  # top instead.
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
    fi
  done

  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save
    echo "iptables: rules saved and will survive a reboot"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "Installing iptables-persistent so the rules survive a reboot"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent
    netfilter-persistent save
  else
    echo "WARNING: could not persist the firewall rules; they will be lost on reboot." >&2
  fi
fi

say "Done on the machine itself"
cat <<'NEXT'
Still to do, and the deploy will not work without them:

  1. In the Oracle Cloud console, open 80 and 443 to 0.0.0.0/0 in the VCN
     security list for this instance's subnet. The firewall above is the
     machine; this is the network in front of it. Both are required.

  2. Point your hostname at this machine's public address. Confirm it resolves
     before continuing — a certificate cannot be issued for a name that does
     not yet point here:

       dig +short your-name.duckdns.org

  3. Then, from the repository:

       cd deploy
       cp .env.example .env      # fill in PASSVAULT_DOMAIN and ACME_EMAIL
       docker compose up -d
NEXT

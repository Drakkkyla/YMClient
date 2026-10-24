#!/bin/bash
# Install Hush on a USB-connected iPhone from WSL with xtool.
# WSL can't see the phone directly, so /var/run/usbmuxd is relayed to Apple Mobile Device
# Service on Windows (127.0.0.1:27015) through a tiny Windows-side Python bridge.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VAULT="$(dirname "$HERE")"
PY=$(command -v python.exe || echo /mnt/c/Python314/python.exe)

pkill -x usbmuxd 2>/dev/null || true
pkill -f "socat UNIX-LISTEN:/var/run/usbmuxd" 2>/dev/null || true
sleep 1; rm -f /var/run/usbmuxd
printf '#!/bin/sh\nexec "%s" -u "%s"\n' "$PY" "$(wslpath -m "$HERE/muxbridge.py")" > /tmp/muxbridge.sh
chmod +x /tmp/muxbridge.sh
socat UNIX-LISTEN:/var/run/usbmuxd,fork,mode=777 EXEC:/tmp/muxbridge.sh 2>/dev/null &
RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT
sleep 1

xtool devices
xtool auth status >/dev/null 2>&1 && xtool auth status | grep -qi "logged in" || xtool auth login

mkdir -p ~/hush
rsync -a --delete --exclude .build --exclude xtool --exclude build "$VAULT/" ~/hush/
cd ~/hush
xtool dev run

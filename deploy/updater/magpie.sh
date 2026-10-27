#!/bin/bash
# Host-only entry point. Root config supplies settings; browser requests supply no commands.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export CHISABOT_UPDATER_DIR=${CHISABOT_UPDATER_DIR:-/opt/chisabot-updater}
if [ -f "$CHISABOT_UPDATER_DIR/config.env" ]; then
  set -a
  . "$CHISABOT_UPDATER_DIR/config.env"
  set +a
fi
exec python3 "$HERE/magpie-update.py" "$@"

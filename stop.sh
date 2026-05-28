#!/usr/bin/env bash
# stop.sh — stop boss-man-dashboard services
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CLEAN_CONTAINERS=false
STOP_INFRA=false

for arg in "$@"; do
  case "$arg" in
    --clean-containers) CLEAN_CONTAINERS=true ;;
    --infra)            STOP_INFRA=true ;;
  esac
done

kill_port() {
  lsof -ti ":$1" 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
  sleep 1
  lsof -ti ":$1" 2>/dev/null | xargs -r kill -KILL 2>/dev/null || true
}

echo "Stopping dev servers..."
[[ -f .server.pid ]] && kill "$(cat .server.pid)" 2>/dev/null || true; rm -f .server.pid
[[ -f .ui.pid ]]     && kill "$(cat .ui.pid)"     2>/dev/null || true; rm -f .ui.pid
kill_port 3001
kill_port 5173
echo "Dev servers stopped"

if [[ "$CLEAN_CONTAINERS" == "true" ]]; then
  echo "Removing sandbox containers..."
  docker ps -q --filter "label=boss-man.managed=true" | xargs -r docker rm -f
  echo "Containers removed"
fi

if [[ "$STOP_INFRA" == "true" ]]; then
  echo "Stopping Docker Compose infrastructure..."
  docker compose down
  echo "Infrastructure stopped"
fi

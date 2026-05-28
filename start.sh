#!/usr/bin/env bash
# start.sh — start all boss-man-dashboard services
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }

# Load env
[[ -f .env ]] || { echo "No .env file — run ./install.sh first"; exit 1; }
set -a; source .env; set +a

# Node version check
node_version=$(node --version | sed 's/v//' | cut -d. -f1)
[[ "$node_version" -ge 22 ]] || { echo "Node.js 22+ required"; exit 1; }

# Validate .env has real values (not placeholders)
if grep -q "change-me" .env; then
  warn "⚠  .env contains placeholder values — edit before continuing"
  grep "change-me" .env | cut -d= -f1 | while read -r key; do warn "  $key"; done
  read -rp "Continue anyway? [y/N] " confirm
  [[ "$confirm" == "y" || "$confirm" == "Y" ]] || exit 1
fi

# ── Infrastructure (Docker Compose) ──────────────────────────────────────────

echo "── Starting infrastructure ──"

if ! curl -sf "http://localhost:${LITELLM_PORT:-4000}/health" >/dev/null 2>&1; then
  docker compose up -d
  echo "Waiting for LiteLLM..."
  for i in $(seq 1 30); do
    curl -sf "http://localhost:${LITELLM_PORT:-4000}/health" >/dev/null 2>&1 && break
    sleep 2
  done
  ok "LiteLLM ready at http://localhost:${LITELLM_PORT:-4000}"
else
  ok "LiteLLM already running"
fi

# ── Kill stale server processes ───────────────────────────────────────────────

for port in "${SERVER_PORT:-3001}" 5173; do
  lsof -ti ":$port" 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
done

# ── Server ────────────────────────────────────────────────────────────────────

echo "── Starting API server ──"
npm run dev --workspace=server &
SERVER_PID=$!
echo "$SERVER_PID" > .server.pid

sleep 2
curl -sf "http://localhost:${SERVER_PORT:-3001}/health" >/dev/null 2>&1 \
  && ok "API server ready at http://localhost:${SERVER_PORT:-3001}" \
  || warn "API server may still be starting..."

# ── UI (Phase 4 — uncomment when ui/ is ready) ───────────────────────────────
# npm run dev --workspace=ui &
# echo $! > .ui.pid

echo ""
echo "╔═════════════════════════════════════════════════╗"
echo "║  Boss Man Dashboard running                     ║"
echo "║                                                 ║"
echo "║  API:      http://localhost:${SERVER_PORT:-3001}            ║"
echo "║  LiteLLM:  http://localhost:${LITELLM_PORT:-4000}            ║"
echo "║  Langfuse: http://localhost:${LANGFUSE_PORT:-3000}            ║"
echo "╚═════════════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C or run ./stop.sh to stop."
wait "$SERVER_PID"

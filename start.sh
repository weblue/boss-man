#!/usr/bin/env bash
# start.sh — start boss-man-dashboard services
# Self-contained: starts full stack if LiteLLM isn't already running on :4000,
# otherwise reuses the existing instance (e.g. from ao-briefcase).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# Load env
[[ -f .env ]] || die "No .env file — run ./install.sh first"
set -a; source .env; set +a

# Node version check
node_version=$(node --version | sed 's/v//' | cut -d. -f1)
[[ "$node_version" -ge 22 ]] || die "Node.js 22+ required"

LITELLM_PORT="${LITELLM_PORT:-4000}"
LANGFUSE_PORT="${LANGFUSE_PORT:-3002}"
DOLT_PORT="${DOLT_PORT:-3306}"
SERVER_PORT="${SERVER_PORT:-3001}"

# ── Detect whether to start standalone LiteLLM or reuse existing ─────────────

echo "── Checking LiteLLM ──"

STANDALONE=false
if curl -sf "http://localhost:${LITELLM_PORT}/health" >/dev/null 2>&1; then
  ok "LiteLLM at :${LITELLM_PORT} already running — reusing existing instance"
  LITELLM_SOURCE="existing"
else
  warn "LiteLLM not found at :${LITELLM_PORT} — starting standalone stack"
  STANDALONE=true
  LITELLM_SOURCE="standalone"
fi

# ── Start Docker services ─────────────────────────────────────────────────────

echo "── Starting Docker services ──"

if [[ "$STANDALONE" == "true" ]]; then
  docker compose --profile standalone up -d
  echo "Waiting for LiteLLM to be ready..."
  for i in $(seq 1 30); do
    curl -sf "http://localhost:${LITELLM_PORT}/health" >/dev/null 2>&1 && break
    sleep 2
  done
  ok "LiteLLM ready at :${LITELLM_PORT}"
else
  # Only start Dolt + Langfuse; skip litellm/postgres (already running)
  docker compose up -d dolt langfuse-web langfuse-db
fi

# Wait for Dolt
for i in $(seq 1 20); do
  docker compose ps dolt 2>/dev/null | grep -q "running" && break
  sleep 2
done
ok "Dolt ready at :${DOLT_PORT}"

# Langfuse health check (non-fatal)
if curl -sf "http://localhost:${LANGFUSE_PORT}/api/public/health" >/dev/null 2>&1; then
  ok "Langfuse at :${LANGFUSE_PORT}"
else
  warn "Langfuse not reachable at :${LANGFUSE_PORT} — traces will not be recorded"
fi

# ── Kill stale server processes ───────────────────────────────────────────────

for port in "${SERVER_PORT}" 5173; do
  lsof -ti ":$port" 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
done

# ── API Server ────────────────────────────────────────────────────────────────

echo "── Starting API server ──"
npm run dev --workspace=server &
SERVER_PID=$!
echo "$SERVER_PID" > .server.pid

sleep 2
curl -sf "http://localhost:${SERVER_PORT}/health" >/dev/null 2>&1 \
  && ok "API server at http://localhost:${SERVER_PORT}" \
  || warn "API server still starting..."

# ── UI (Phase 4 — uncomment when ui/ is ready) ───────────────────────────────
# npm run dev --workspace=ui &
# echo $! > .ui.pid

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Boss Man Dashboard running                          ║"
echo "║                                                      ║"
printf "║  API:      http://localhost:%-26s║\n" "${SERVER_PORT}"
printf "║  LiteLLM:  http://localhost:%-4s (%s)%-$((15 - ${#LITELLM_SOURCE}))s║\n" "${LITELLM_PORT}" "${LITELLM_SOURCE}" ""
printf "║  Langfuse: http://localhost:%-26s║\n" "${LANGFUSE_PORT}"
printf "║  Dolt:     localhost:%-33s║\n" "${DOLT_PORT}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C or run ./stop.sh to stop."
wait "$SERVER_PID"

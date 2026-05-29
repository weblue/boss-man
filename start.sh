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

SERVER_PID=""
UI_PID=""

cleanup() {
  local code=$?
  trap - INT TERM EXIT
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${UI_PID:-}" ]] && kill -0 "$UI_PID" 2>/dev/null; then
    kill -TERM "$UI_PID" 2>/dev/null || true
  fi
  [[ -n "${SERVER_PID:-}" ]] && wait "$SERVER_PID" 2>/dev/null || true
  [[ -n "${UI_PID:-}" ]] && wait "$UI_PID" 2>/dev/null || true
  rm -f .server.pid .ui.pid
  if [[ "$code" -eq 130 || "$code" -eq 143 ]]; then
    echo ""
    ok "Boss Man Dashboard stopped"
    exit 0
  fi
  exit "$code"
}

trap cleanup INT TERM EXIT

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
SANDBOX_IMAGE="${SANDBOX_IMAGE:-boss-man:sandbox}"

# ── Detect whether to start standalone LiteLLM or reuse existing ─────────────

echo "── Checking LiteLLM ──"

STANDALONE=false
if curl -sf "http://localhost:${LITELLM_PORT}/health/liveliness" >/dev/null 2>&1; then
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
    curl -sf "http://localhost:${LITELLM_PORT}/health/liveliness" >/dev/null 2>&1 && break
    sleep 2
  done
  ok "LiteLLM ready at :${LITELLM_PORT}"
else
  # Only start Dolt + Langfuse; skip litellm/postgres (already running)
  docker compose up -d dolt langfuse-web langfuse-db
fi

# Wait for Dolt
for i in $(seq 1 20); do
  docker compose ps dolt 2>/dev/null | grep -qi "running" && break
  sleep 2
done
ok "Dolt ready at :${DOLT_PORT}"

# Langfuse health check (non-fatal)
if curl -sf "http://localhost:${LANGFUSE_PORT}/api/public/health" >/dev/null 2>&1; then
  ok "Langfuse at :${LANGFUSE_PORT}"
else
  warn "Langfuse not reachable at :${LANGFUSE_PORT} — traces will not be recorded"
fi

# ── Sandbox image ─────────────────────────────────────────────────────────────

echo "── Checking sandbox image ──"
if docker image inspect "${SANDBOX_IMAGE}" >/dev/null 2>&1; then
  ok "Sandbox image ${SANDBOX_IMAGE} found"
else
  die "Sandbox image ${SANDBOX_IMAGE} missing — run ./install.sh to build it"
fi

# ── Kill stale server processes ───────────────────────────────────────────────

for port in "${SERVER_PORT}" 5173; do
  lsof -ti ":$port" 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true
done

# ── API Server ────────────────────────────────────────────────────────────────

echo "── Starting API server ──"
(
  cd server
  ../node_modules/.bin/tsx watch src/index.ts
) &
SERVER_PID=$!
echo "$SERVER_PID" > .server.pid

sleep 2
curl -sf "http://localhost:${SERVER_PORT}/health" >/dev/null 2>&1 \
  && ok "API server at http://localhost:${SERVER_PORT}" \
  || warn "API server still starting..."

# ── UI ────────────────────────────────────────────────────────────────────────
(
  cd ui
  ../node_modules/.bin/vite --host 0.0.0.0
) &
UI_PID=$!
echo "$UI_PID" > .ui.pid

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Boss Man Dashboard running                          ║"
echo "║                                                      ║"
printf "║  API:      http://localhost:%-26s║\n" "${SERVER_PORT}"
printf "║  UI:       http://localhost:%-26s║\n" "5173"
printf "║  LiteLLM:  http://localhost:%-4s (%s)%-$((15 - ${#LITELLM_SOURCE}))s║\n" "${LITELLM_PORT}" "${LITELLM_SOURCE}" ""
printf "║  Langfuse: http://localhost:%-26s║\n" "${LANGFUSE_PORT}"
printf "║  Dolt:     localhost:%-33s║\n" "${DOLT_PORT}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C or run ./stop.sh to stop."
wait "$SERVER_PID" "$UI_PID"

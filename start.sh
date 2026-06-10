#!/usr/bin/env bash
# start.sh — start boss-man-dashboard services
# Self-contained: starts full stack if LiteLLM isn't already running on :4000,
# otherwise reuses the existing instance (e.g. from ao-briefcase).
#
# Flags:
#   -y / --yes   Skip the model-profile menu and use BOSS_MAN_AUTH_MODE /
#                BOSS_MAN_PROFILE_* env vars (set in .env), or built-in defaults.
#
# Auth modes
# ──────────
#   claude  — All tiers use native Claude models. claude-code is the only
#             harness used. NO ANTHROPIC_BASE_URL/KEY are injected into the
#             sandbox; claude-code authenticates via ~/.claude subscription.
#
#   litellm — All tiers route through LiteLLM (local models, OpenAI, etc.).
#             ANTHROPIC_BASE_URL/KEY and OPENAI_BASE_URL/KEY are injected with
#             the LiteLLM URL + master key. Any agent harness is allowed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# ── Parse flags ───────────────────────────────────────────────────────────────
NONINTERACTIVE=false
for arg in "$@"; do
  [[ "$arg" == "-y" || "$arg" == "--yes" ]] && NONINTERACTIVE=true
done
[[ ! -e /dev/tty ]] && NONINTERACTIVE=true   # CI / piped input

SERVER_PID=""

cleanup() {
  local code=$?
  trap - INT TERM EXIT
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  [[ -n "${SERVER_PID:-}" ]] && wait "$SERVER_PID" 2>/dev/null || true
  docker rm -f boss-man-nginx 2>/dev/null || true
  rm -f .server.pid
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
SERVER_PORT="${SERVER_PORT:-8771}"
UI_PORT="${UI_PORT:-8770}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-boss-man:sandbox}"

# ── Model Profile ─────────────────────────────────────────────────────────────
#
# Two-step selection:
#   1. Auth mode: Claude subscription (native) vs LiteLLM proxy
#   2. Model per tier — options depend on mode
#
# Claude mode  → claude-code locked, no ANTHROPIC env injection in sandbox
# LiteLLM mode → agent unrestricted, both ANTHROPIC+OPENAI vars set to LiteLLM
#
# Non-interactive defaults:
#   BOSS_MAN_AUTH_MODE in .env  →  'claude' (default) or 'litellm'
#   BOSS_MAN_PROFILE_HIGH/MED/LOW in .env  →  model label for each tier

# Print a numbered menu to stderr; echo the chosen label to stdout.
pick() {
  local label="$1"; shift
  local -a opts=("$@")

  printf "\n  %-8s" "[$label]" >&2
  local i; for ((i=0; i<${#opts[@]}; i++)); do
    local mark=""; (( i == 0 )) && mark=" (default)"
    printf "  %d) %s%s" "$((i+1))" "${opts[$i]}" "$mark" >&2
  done
  printf "\n         → [1]: " >&2

  local choice
  read -r choice </dev/tty 2>/dev/null || choice=""
  choice="${choice:-1}"
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#opts[@]} )); then
    choice=1
  fi
  echo "${opts[$((choice-1))]}"
}

# Short display name for the banner.
abbrev() {
  case "$1" in
    claude-opus-4-7)   echo "opus";;
    claude-sonnet-4-6) echo "sonnet";;
    claude-haiku-4-5)  echo "haiku";;
    local-worker)      echo "local";;
    gpt-4o)            echo "gpt-4o";;
    gpt-4o-mini)       echo "gpt-4o-mini";;
    *)                 echo "${1:0:10}";;
  esac
}

# Convert a Claude model label to the claude-code --model alias.
claude_code_alias() {
  case "$1" in
    claude-opus-4-7)   echo "opus";;
    claude-sonnet-4-6) echo "sonnet";;
    claude-haiku-4-5)  echo "haiku";;
    *)                 echo "$1";;
  esac
}

# Emit a tier entry block for litellm-config.yaml.
emit_tier_block() {
  local name="$1" label="$2"
  printf '  - model_name: %s\n' "$name"
  case "$label" in
    local-worker)
      local lm="${BOSS_MAN_LOCAL_MODEL:-ollama_chat/hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M}"
      printf '    litellm_params:\n      model: %s\n      api_base: http://host.docker.internal:11434\n\n' "$lm";;
    gpt-4o)
      printf '    litellm_params:\n      model: openai/gpt-4o\n      api_key: os.environ/OPENAI_API_KEY\n\n';;
    gpt-4o-mini)
      printf '    litellm_params:\n      model: openai/gpt-4o-mini\n      api_key: os.environ/OPENAI_API_KEY\n\n';;
    claude-*)
      printf '    litellm_params:\n      model: anthropic/%s\n      api_key: os.environ/ANTHROPIC_API_KEY\n\n' "$label";;
  esac
}

write_litellm_config() {
  local lm="${BOSS_MAN_LOCAL_MODEL:-ollama_chat/hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M}"
  {
    cat <<'HDR'
# Boss Man Dashboard — LiteLLM config
# Auto-generated by start.sh — re-run ./start.sh to change model profile.
# Anthropic/Claude models are NOT listed here; they route natively through
# claude-code in Claude mode (subscription auth, no API key required).

model_list:
HDR

    if [[ "$AUTH_MODE" == "litellm" ]]; then
      printf '  # ── Tier aliases (LiteLLM profile, set at last boot) ─────────────────────\n'
      emit_tier_block "boss-man/high"   "$PROFILE_HIGH"
      emit_tier_block "boss-man/medium" "$PROFILE_MED"
      emit_tier_block "boss-man/low"    "$PROFILE_LOW"
    elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
      # Claude mode: agents auth via subscription, but server-side helpers (the
      # rolling-summary fold) call boss-man/* through LiteLLM — back them with
      # the Anthropic API when a key is available.
      printf '  # ── Tier aliases (claude mode, API-key backed for server-side calls) ─────\n'
      emit_tier_block "boss-man/high"   "$PROFILE_HIGH"
      emit_tier_block "boss-man/medium" "$PROFILE_MED"
      emit_tier_block "boss-man/low"    "$PROFILE_LOW"
    fi

    printf '  # ── Local model (requires Ollama on host) ───────────────────────────────\n'
    printf '  - model_name: local-worker\n'
    printf '    litellm_params:\n'
    printf '      model: %s\n' "$lm"
    printf '      api_base: http://host.docker.internal:11434\n'
    printf '    model_info:\n'
    printf '      supports_function_calling: true\n'
    printf '      route_family: local\n'
    printf '      intended_complexity: simple\n\n'

    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
      cat <<'OPENAI'
  # ── OpenAI models (via LiteLLM — requires OPENAI_API_KEY in .env) ─────────
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  - model_name: gpt-4o-mini
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY

OPENAI
    fi

    cat <<'FOOTER'
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  forward_client_headers_to_llm_api: true

litellm_settings:
  drop_params: true
  store_prompts_in_spend_logs: true
  success_callback:
    - langfuse
  failure_callback:
    - langfuse
FOOTER
  } > litellm-config.yaml
}

echo "── Model Profile ──"

if [[ "$NONINTERACTIVE" == "true" ]]; then
  AUTH_MODE="${BOSS_MAN_AUTH_MODE:-claude}"
  if [[ "$AUTH_MODE" == "litellm" ]]; then
    PROFILE_HIGH="${BOSS_MAN_PROFILE_HIGH:-local-worker}"
    PROFILE_MED="${BOSS_MAN_PROFILE_MED:-local-worker}"
    PROFILE_LOW="${BOSS_MAN_PROFILE_LOW:-local-worker}"
  else
    AUTH_MODE="claude"
    PROFILE_HIGH="${BOSS_MAN_PROFILE_HIGH:-claude-opus-4-7}"
    PROFILE_MED="${BOSS_MAN_PROFILE_MED:-claude-sonnet-4-6}"
    PROFILE_LOW="${BOSS_MAN_PROFILE_LOW:-claude-haiku-4-5}"
  fi
  echo "  Using ${AUTH_MODE} mode (non-interactive)."
  echo "  Tip: set BOSS_MAN_AUTH_MODE and BOSS_MAN_PROFILE_* in .env then use -y."
else
  echo "  Step 1 of 2: Choose authentication mode."
  echo "  (Add BOSS_MAN_AUTH_MODE to .env and use -y to skip this menu.)"

  AUTH_CHOICE=$(pick "mode" \
    "Claude subscription  — native auth, claude-code only" \
    "LiteLLM proxy        — local / OpenAI models, any agent")

  if [[ "$AUTH_CHOICE" == *"Claude"* ]]; then
    AUTH_MODE="claude"
    echo ""
    echo "  Step 2 of 2: Choose Claude model per tier."
    PROFILE_HIGH=$(pick "high"   "claude-opus-4-7" "claude-sonnet-4-6" "claude-haiku-4-5")
    PROFILE_MED=$(pick  "medium" "claude-sonnet-4-6" "claude-haiku-4-5" "claude-opus-4-7")
    PROFILE_LOW=$(pick  "low"    "claude-haiku-4-5" "claude-sonnet-4-6")
  else
    AUTH_MODE="litellm"
    echo ""
    echo "  Step 2 of 2: Choose LiteLLM model per tier."
    LITELLM_OPTS=("local-worker")
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
      LITELLM_OPTS+=("gpt-4o" "gpt-4o-mini")
    fi
    PROFILE_HIGH=$(pick "high"   "${LITELLM_OPTS[@]}")
    PROFILE_MED=$(pick  "medium" "${LITELLM_OPTS[@]}")
    PROFILE_LOW=$(pick  "low"    "${LITELLM_OPTS[@]}")
  fi
  echo ""
fi

# Export auth mode and agent enforcement for the API server subprocess.
export BOSS_MAN_AUTH_MODE="$AUTH_MODE"

# In Claude mode, export the per-tier model aliases so the server can pass the
# correct --model flag to claude-code (e.g. 'opus', 'sonnet', 'haiku').
if [[ "$AUTH_MODE" == "claude" ]]; then
  export CLAUDE_CODE_HIGH_MODEL="$(claude_code_alias "$PROFILE_HIGH")"
  export CLAUDE_CODE_MEDIUM_MODEL="$(claude_code_alias "$PROFILE_MED")"
  export CLAUDE_CODE_LOW_MODEL="$(claude_code_alias "$PROFILE_LOW")"
fi

# (Re)generate litellm-config.yaml before LiteLLM starts.
write_litellm_config

ok "Mode:    ${AUTH_MODE}"
ok "Profile: high=$(abbrev "$PROFILE_HIGH") · medium=$(abbrev "$PROFILE_MED") · low=$(abbrev "$PROFILE_LOW")"
if [[ "$AUTH_MODE" == "claude" ]]; then
  warn "claude-code locked — ANTHROPIC env vars NOT injected (subscription auth)"
else
  ok "Agent unrestricted — LiteLLM URL+key injected as ANTHROPIC + OPENAI env vars"
fi

# ── Detect whether to start standalone LiteLLM or reuse existing ─────────────

echo "── Checking LiteLLM ──"

STANDALONE=false
if curl -sf "http://localhost:${LITELLM_PORT}/health/liveliness" >/dev/null 2>&1; then
  ok "LiteLLM at :${LITELLM_PORT} already running — reusing existing instance"
  warn "Model profile changes won't take effect until that instance is restarted"
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
  docker compose up -d langfuse-web langfuse-db
fi

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

# ── Native module check ───────────────────────────────────────────────────────

echo "── Checking native modules ──"
if ! node -e "require('./node_modules/better-sqlite3')" >/dev/null 2>&1; then
  warn "better-sqlite3 binary mismatch for Node.js $(node --version) — rebuilding..."
  npm rebuild better-sqlite3 >/dev/null 2>&1 \
    && ok "better-sqlite3 rebuilt" \
    || die "Failed to rebuild better-sqlite3. Run ./install.sh to fully reinstall."
else
  ok "better-sqlite3 ok"
fi

# ── Kill stale processes / containers ────────────────────────────────────────

docker rm -f boss-man-nginx 2>/dev/null || true
lsof -ti ":${SERVER_PORT}" 2>/dev/null | xargs -r kill -TERM 2>/dev/null || true

# ── API Server ────────────────────────────────────────────────────────────────

echo "── Starting API server ──"
(
  cd server
  ../node_modules/.bin/tsx watch src/index.ts
) &
SERVER_PID=$!
echo "$SERVER_PID" > .server.pid

echo "Waiting for API server to be ready..."
for i in $(seq 1 20); do
  curl -sf "http://localhost:${SERVER_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:${SERVER_PORT}/health" >/dev/null 2>&1 \
  && ok "API server at http://localhost:${SERVER_PORT}" \
  || warn "API server not yet responding at :${SERVER_PORT} — check logs if it fails to start"

# ── UI — build then serve with nginx ─────────────────────────────────────────

echo "── Building UI ──"
(cd ui && ../node_modules/.bin/vite build --logLevel warn)
ok "UI built → ui/dist/"

echo "── Starting nginx ──"
# Render the nginx config template: substitute __SERVER_PORT__ with the actual port.
sed "s/__SERVER_PORT__/${SERVER_PORT}/g" "$SCRIPT_DIR/nginx/nginx.conf" \
  > "$SCRIPT_DIR/nginx/.current.conf"
docker run -d \
  --name boss-man-nginx \
  -p "${UI_PORT}:80" \
  -v "$SCRIPT_DIR/ui/dist:/usr/share/nginx/html:ro" \
  -v "$SCRIPT_DIR/nginx/.current.conf:/etc/nginx/conf.d/default.conf:ro" \
  --add-host=host.docker.internal:host-gateway \
  nginx:alpine >/dev/null

echo "Waiting for nginx to be ready..."
for i in $(seq 1 15); do
  curl -sf "http://localhost:${UI_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:${UI_PORT}/health" >/dev/null 2>&1 \
  && ok "nginx at http://localhost:${UI_PORT}" \
  || warn "nginx not yet responding at :${UI_PORT} — check: docker logs boss-man-nginx"

# Banner (inner content = 54 chars between the ║ bookends)
MODE_DESC="${AUTH_MODE} ($([ "$AUTH_MODE" == "claude" ] && echo "subscription" || echo "LiteLLM proxy"))"
AGENT_DESC="$([ "$AUTH_MODE" == "claude" ] && echo "claude-code (locked)" || echo "unrestricted")"
PROFILE_DESC="high=$(abbrev "$PROFILE_HIGH") · medium=$(abbrev "$PROFILE_MED") · low=$(abbrev "$PROFILE_LOW")"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Boss Man Dashboard running                          ║"
echo "║                                                      ║"
printf "║  API:      http://localhost:%-26s║\n" "${SERVER_PORT}"
printf "║  UI:       http://localhost:%-26s║\n" "${UI_PORT}"
printf "║  LiteLLM:  http://localhost:%-4s (%s)%-$((15 - ${#LITELLM_SOURCE}))s║\n" "${LITELLM_PORT}" "${LITELLM_SOURCE}" ""
printf "║  Langfuse: http://localhost:%-26s║\n" "${LANGFUSE_PORT}"
echo "║                                                      ║"
printf "║  Mode:     %-42s║\n" "$MODE_DESC"
printf "║  Profile:  %-42s║\n" "$PROFILE_DESC"
printf "║  Agent:    %-42s║\n" "$AGENT_DESC"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C or run ./stop.sh to stop."
wait "$SERVER_PID"

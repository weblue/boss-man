#!/usr/bin/env bash
# install.sh — one-shot reproducible setup for boss-man-dashboard
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      Boss Man Dashboard — Setup      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. System prerequisites ─────────────────────────────────────────────────

echo "── Checking prerequisites ──"

node_version=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
if [[ "$node_version" -lt 22 ]]; then
  die "Node.js 22+ required (found: $(node --version 2>/dev/null || echo 'none')). Install via nvm: nvm install 22"
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  die "npm not found"
fi
ok "npm $(npm --version)"

if ! command -v docker &>/dev/null; then
  die "Docker not found. Install from https://docs.docker.com/get-docker/"
fi
ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

if ! docker compose version &>/dev/null; then
  die "Docker Compose v2 not found. Update Docker Desktop or install the compose plugin."
fi
ok "Docker Compose $(docker compose version --short)"

if ! command -v git &>/dev/null; then
  die "git not found"
fi
ok "git $(git --version | awk '{print $3}')"

# ── 2. PrismoDev check ───────────────────────────────────────────────────────

echo ""
echo "── Checking PrismoDev (prismo) ──"

if command -v getprismo &>/dev/null; then
  ok "prismo installed: $(getprismo --version 2>/dev/null || echo 'version unknown')"
elif command -v npx &>/dev/null && npx --no getprismo --version &>/dev/null 2>&1; then
  ok "prismo available via npx"
else
  warn "prismo not found — install it with: npm install -g getprismo"
  warn "Then run 'getprismo doctor' in each project directory before starting work."
fi
# NOTE: prismo doctor is intentionally NOT run during install — it scans the project
# and can stall on large repos. Run it manually per-project: getprismo doctor

# ── 3. Environment file ──────────────────────────────────────────────────────

echo ""
echo "── Setting up .env ──"

if [[ -f .env ]]; then
  ok ".env already exists — skipping generation"
else
  cp .env.example .env

  # Generate random secrets
  LITELLM_MASTER_KEY="sk-boss-man-$(openssl rand -hex 16)"
  LITELLM_API_KEY="$LITELLM_MASTER_KEY"
  LITELLM_SALT_KEY="$(openssl rand -hex 32)"
  POSTGRES_PASSWORD="$(openssl rand -hex 16)"
  LANGFUSE_DB_PASSWORD="$(openssl rand -hex 16)"
  LANGFUSE_NEXTAUTH_SECRET="$(openssl rand -hex 32)"
  LANGFUSE_SALT="$(openssl rand -hex 16)"
  LANGFUSE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
  LANGFUSE_SECRET_KEY="sk-lf-$(openssl rand -hex 16)"
  LANGFUSE_PUBLIC_KEY="pk-lf-$(openssl rand -hex 16)"

  sed -i.bak \
    -e "s|LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=$LITELLM_MASTER_KEY|" \
    -e "s|LITELLM_API_KEY=.*|LITELLM_API_KEY=$LITELLM_API_KEY|" \
    -e "s|LITELLM_SALT_KEY=.*|LITELLM_SALT_KEY=$LITELLM_SALT_KEY|" \
    -e "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
    -e "s|LANGFUSE_DB_PASSWORD=.*|LANGFUSE_DB_PASSWORD=$LANGFUSE_DB_PASSWORD|" \
    -e "s|LANGFUSE_NEXTAUTH_SECRET=.*|LANGFUSE_NEXTAUTH_SECRET=$LANGFUSE_NEXTAUTH_SECRET|" \
    -e "s|LANGFUSE_SALT=.*|LANGFUSE_SALT=$LANGFUSE_SALT|" \
    -e "s|LANGFUSE_ENCRYPTION_KEY=.*|LANGFUSE_ENCRYPTION_KEY=$LANGFUSE_ENCRYPTION_KEY|" \
    -e "s|LANGFUSE_SECRET_KEY=.*|LANGFUSE_SECRET_KEY=$LANGFUSE_SECRET_KEY|" \
    -e "s|LANGFUSE_PUBLIC_KEY=.*|LANGFUSE_PUBLIC_KEY=$LANGFUSE_PUBLIC_KEY|" \
    .env
  rm -f .env.bak

  # Copy existing API keys from shell environment
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    sed -i.bak "s|ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY|" .env
    rm -f .env.bak
    ok "ANTHROPIC_API_KEY copied from environment"
  else
    warn "ANTHROPIC_API_KEY not set — edit .env before starting"
  fi

  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    sed -i.bak "s|OPENAI_API_KEY=.*|OPENAI_API_KEY=$OPENAI_API_KEY|" .env
    rm -f .env.bak
    ok "OPENAI_API_KEY copied from environment"
  fi

  ok ".env generated with random secrets"
fi

# ── 4. Node dependencies ──────────────────────────────────────────────────────

echo ""
echo "── Installing Node dependencies ──"
npm install
ok "Node dependencies installed"

# ── 5. Build sandbox Docker image ─────────────────────────────────────────────

echo ""
echo "── Building sandbox Docker image (boss-man:sandbox) ──"
echo "   This installs Claude Code, prismo, and spawn-worker in the agent sandbox."

docker build \
  --build-arg "BEADS_VERSION=${BEADS_VERSION:-1.0.4}" \
  -t "${SANDBOX_IMAGE:-boss-man:sandbox}" \
  -f sandcastle/Dockerfile \
  .
ok "boss-man:sandbox image built"

echo "── Verifying sandbox Docker image ──"
SANDBOX_TEST_CONTAINER="boss-man-sandbox-smoke-$$"
docker rm -f "$SANDBOX_TEST_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$SANDBOX_TEST_CONTAINER" "${SANDBOX_IMAGE:-boss-man:sandbox}" >/dev/null
if ! docker exec "$SANDBOX_TEST_CONTAINER" sh -lc \
  'test -w "$HOME" && git config --global --add safe.directory /home/agent/workspace && command -v bd && command -v claude && command -v spawn-worker' >/dev/null; then
  docker logs "$SANDBOX_TEST_CONTAINER" 2>/dev/null || true
  docker rm -f "$SANDBOX_TEST_CONTAINER" >/dev/null 2>&1 || true
  die "Sandbox image smoke test failed"
fi
docker rm -f "$SANDBOX_TEST_CONTAINER" >/dev/null
ok "Sandbox image verified"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Setup complete!                                 ║"
echo "║                                                  ║"
echo "║  Edit .env to confirm API keys, then:           ║"
echo "║    ./start.sh                                    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

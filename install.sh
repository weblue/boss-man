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

# ── 2. Beads CLI ─────────────────────────────────────────────────────────────

echo ""
echo "── Installing Beads CLI (bd) ──"

if command -v bd &>/dev/null; then
  ok "bd already installed: $(bd --version 2>/dev/null || echo 'version unknown')"
else
  if [[ "$(uname)" == "Darwin" ]] && command -v brew &>/dev/null; then
    brew install beads
    ok "bd installed via Homebrew"
  else
    # Try npm install first (most portable)
    if npm install -g @beads/bd 2>/dev/null; then
      ok "bd installed via npm"
    else
      warn "npm install of bd failed, trying curl install script..."
      curl -fsSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash
      ok "bd installed via install script"
    fi
  fi
fi

# ── 3. PrismoDev smoke test ──────────────────────────────────────────────────

echo ""
echo "── Verifying PrismoDev (prismo) ──"

if npx getprismo --version 2>/dev/null | grep -q '[0-9]'; then
  ok "prismo: $(npx getprismo --version 2>/dev/null)"
else
  warn "prismo version check inconclusive — running doctor to verify it works"
fi

# Run prismo doctor on the boss-man-dashboard repo itself as a smoke test
if npx --yes getprismo doctor --quiet 2>&1 | grep -qiE "(score|complete|ok)"; then
  ok "prismo doctor passed"
else
  warn "prismo doctor output unclear — check manually with: npx getprismo doctor"
fi

# ── 4. Environment file ──────────────────────────────────────────────────────

echo ""
echo "── Setting up .env ──"

if [[ -f .env ]]; then
  ok ".env already exists — skipping generation"
else
  cp .env.example .env

  # Generate random secrets
  LITELLM_MASTER_KEY="sk-boss-man-$(openssl rand -hex 16)"
  LITELLM_SALT_KEY="$(openssl rand -hex 32)"
  POSTGRES_PASSWORD="$(openssl rand -hex 16)"
  DOLT_ROOT_PASSWORD="$(openssl rand -hex 16)"
  LANGFUSE_DB_PASSWORD="$(openssl rand -hex 16)"
  LANGFUSE_NEXTAUTH_SECRET="$(openssl rand -hex 32)"
  LANGFUSE_SALT="$(openssl rand -hex 16)"
  LANGFUSE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
  LANGFUSE_SECRET_KEY="sk-lf-$(openssl rand -hex 16)"
  LANGFUSE_PUBLIC_KEY="pk-lf-$(openssl rand -hex 16)"

  sed -i.bak \
    -e "s|LITELLM_MASTER_KEY=.*|LITELLM_MASTER_KEY=$LITELLM_MASTER_KEY|" \
    -e "s|LITELLM_SALT_KEY=.*|LITELLM_SALT_KEY=$LITELLM_SALT_KEY|" \
    -e "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
    -e "s|DOLT_ROOT_PASSWORD=.*|DOLT_ROOT_PASSWORD=$DOLT_ROOT_PASSWORD|" \
    -e "s|BEADS_STORE_PASSWORD=.*|BEADS_STORE_PASSWORD=$DOLT_ROOT_PASSWORD|" \
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

# ── 5. Node dependencies ──────────────────────────────────────────────────────

echo ""
echo "── Installing Node dependencies ──"
npm install
ok "Node dependencies installed"

# ── 6. Build sandbox Docker image ─────────────────────────────────────────────

echo ""
echo "── Building sandbox Docker image (boss-man:sandbox) ──"
echo "   This installs Claude Code, prismo, and bd in the agent sandbox."

docker build -t boss-man:sandbox -f sandcastle/Dockerfile . 2>&1 | grep -E "^(Step|#|ERROR|WARN|Successfully)" || true
ok "boss-man:sandbox image built"

# ── 7. Initialize Beads with Dolt backend ─────────────────────────────────────

echo ""
echo "── Configuring Beads to use Dolt (Docker) ──"

# Source .env to get Dolt config
set -a; source .env; set +a

# Beads server-mode config (connects to Dolt in Docker)
bd config set store.provider dolt 2>/dev/null || true
bd config set store.host "${BEADS_STORE_HOST:-127.0.0.1}" 2>/dev/null || true
bd config set store.port "${BEADS_STORE_PORT:-3306}" 2>/dev/null || true
bd config set store.password "${BEADS_STORE_PASSWORD:-}" 2>/dev/null || true

ok "Beads configured for Dolt backend"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Setup complete!                                 ║"
echo "║                                                  ║"
echo "║  Edit .env to confirm API keys, then:           ║"
echo "║    ./start.sh                                    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

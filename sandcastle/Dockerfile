FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq bash tmux python3 python3-pip \
    build-essential ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Codex CLI (OpenAI coding agent)
RUN npm install -g @openai/codex

# Pi CLI (coding agent)
RUN npm install -g @earendil-works/pi-coding-agent

# PrismoDev (token efficiency)
RUN npm install -g getprismo

# spawn-worker CLI (copied at build time; bind-mounted at runtime in dev)
COPY scripts/spawn-worker /usr/local/bin/spawn-worker
RUN chmod +x /usr/local/bin/spawn-worker

# Git identity for commits inside sandbox.
# Use --system so the config lives in /etc/gitconfig and applies to any uid
# (Sandcastle runs the container as the host user, not root).
RUN git config --system user.email "boss-man-agent@localhost" && \
    git config --system user.name "Boss Man Agent" && \
    git config --system safe.directory '*'

RUN mkdir -p /home/agent && chmod 777 /home/agent

# Sandcastle mounts the repo worktree at /home/agent/workspace (its default).
# We set that as WORKDIR so the container starts there, then symlink /workspace
# → /home/agent/workspace so orchestrator/worker prompts can use either path.
RUN mkdir -p /home/agent/workspace && chmod 777 /home/agent/workspace
WORKDIR /home/agent/workspace
RUN ln -sf /home/agent/workspace /workspace

# RTK — token-efficiency proxy (60-90% savings on dev commands)
ARG RTK_VERSION=0.42.3
RUN set -e && \
    ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) RTK_ARCH="x86_64-unknown-linux-musl" ;; \
      arm64) RTK_ARCH="aarch64-unknown-linux-gnu" ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-${RTK_ARCH}.tar.gz" \
      | tar xz -C /usr/local/bin rtk && \
    chmod +x /usr/local/bin/rtk

# Claude Code: skip interactive permission prompts in headless mode
ENV CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS=1

CMD ["sleep", "infinity"]

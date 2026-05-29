FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq bash tmux python3 python3-pip \
    build-essential ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# PrismoDev (token efficiency)
RUN npm install -g getprismo

# Beads CLI. Use the npm package instead of hardcoded GitHub release asset
# names, which have changed across Beads releases.
ARG BEADS_VERSION=1.0.4
RUN npm install -g "@beads/bd@${BEADS_VERSION}"

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

# Claude Code: skip interactive permission prompts in headless mode
ENV CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS=1

CMD ["sleep", "infinity"]

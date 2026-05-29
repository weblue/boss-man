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

# Git identity for commits inside sandbox
RUN git config --global user.email "boss-man-agent@localhost" && \
    git config --global user.name "Boss Man Agent"

RUN mkdir -p /home/agent && chmod 777 /home/agent

WORKDIR /workspace

# Claude Code: skip interactive permission prompts in headless mode
ENV CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS=1

CMD ["sleep", "infinity"]

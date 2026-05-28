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

# Beads CLI — installed from GitHub releases to match host bd version
ARG BEADS_VERSION=v1.0.4
RUN ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in \
      amd64) BEADS_ARCH="linux-amd64" ;; \
      arm64) BEADS_ARCH="linux-arm64" ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/gastownhall/beads/releases/download/${BEADS_VERSION}/bd-${BEADS_ARCH}" \
      -o /usr/local/bin/bd && \
    chmod +x /usr/local/bin/bd

# spawn-worker CLI (copied at build time; bind-mounted at runtime in dev)
COPY scripts/spawn-worker /usr/local/bin/spawn-worker
RUN chmod +x /usr/local/bin/spawn-worker

# Git identity for commits inside sandbox
RUN git config --global user.email "boss-man-agent@localhost" && \
    git config --global user.name "Boss Man Agent"

WORKDIR /workspace

# Claude Code: skip interactive permission prompts in headless mode
ENV CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS=1

CMD ["bash"]

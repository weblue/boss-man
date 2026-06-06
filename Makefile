.PHONY: sandbox sandbox-push install start stop typecheck help

SANDBOX_IMAGE  ?= boss-man:sandbox

# ── Sandbox image ────────────────────────────────────────────────────────────

## sandbox   — Build the agent sandbox Docker image
sandbox:
	docker build \
		-t $(SANDBOX_IMAGE) \
		-f sandcastle/Dockerfile \
		.

## sandbox-push — Build and push the sandbox image (set SANDBOX_IMAGE=ghcr.io/org/repo:tag)
sandbox-push: sandbox
	docker push $(SANDBOX_IMAGE)

# ── Dev lifecycle ─────────────────────────────────────────────────────────────

## install   — One-shot setup (prereqs, .env, Node deps, sandbox image, Beads init)
install:
	./install.sh

## start     — Start all services (Docker stack + API server + UI dev server)
start:
	./start.sh

## stop      — Stop all services
stop:
	./stop.sh

# ── Quality ───────────────────────────────────────────────────────────────────

## typecheck — Run TypeScript type checks across all workspaces
typecheck:
	npm run typecheck

## test      — Run test suites across all workspaces
test:
	npm run test

# ── Help ──────────────────────────────────────────────────────────────────────

## help      — Show this help message
help:
	@grep -E '^## ' Makefile | sed 's/^## /  /'

.DEFAULT_GOAL := help

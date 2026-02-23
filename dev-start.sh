#!/bin/bash
set -euo pipefail

# =============================================================================
# Dust Local Dev — Start Everything
# =============================================================================
# Starts: Docker infra, Temporal, Core API (Rust), OAuth, Temporal workers, Next.js
# Usage:  ./dev-start.sh
# Stop:   Ctrl+C (kills all child processes)
# =============================================================================

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONT_DIR="$ROOT_DIR/front"
CORE_BIN="$ROOT_DIR/core/target/release/core-api"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[dev]${NC} $1"; }
ok()  { echo -e "${GREEN}[dev]${NC} $1"; }
warn(){ echo -e "${YELLOW}[dev]${NC} $1"; }
err() { echo -e "${RED}[dev]${NC} $1"; }

cleanup() {
  log "Shutting down..."
  kill 0 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# ---- Env ----
if [ ! -f "$FRONT_DIR/.env" ]; then
  err "front/.env not found. Run: cp front/.env.example front/.env"
  exit 1
fi
set -a && source "$FRONT_DIR/.env" && set +a
ok "Loaded front/.env"

# ---- Docker ----
log "Starting Docker services..."
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d 2>&1 | tail -1
ok "Docker services up (Postgres, Redis, ES, Qdrant, Tika)"

# ---- Temporal ----
if lsof -iTCP:7233 -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  ok "Temporal already running on :7233"
else
  log "Starting Temporal..."
  temporal server start-dev --log-level error &
  sleep 3
  ok "Temporal started on :7233"
fi
temporal operator search-attribute create --name workspaceId --type Text 2>/dev/null || true
temporal operator search-attribute create --name conversationId --type Text 2>/dev/null || true

# ---- Core API (Rust) ----
if [ ! -f "$CORE_BIN" ]; then
  warn "Core API not built. Run: cd core && cargo build --release"
  warn "Skipping — LLM calls will fail without it."
else
  if lsof -iTCP:3001 -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    ok "Core API already running on :3001"
  else
    log "Starting Core API..."
    CORE_DATABASE_URI="${FRONT_DATABASE_URI}" \
    ELASTICSEARCH_URL="${ELASTICSEARCH_URL}" \
    ELASTICSEARCH_USERNAME="${ELASTICSEARCH_USERNAME}" \
    ELASTICSEARCH_PASSWORD="${ELASTICSEARCH_PASSWORD}" \
    QDRANT_CLUSTER_0_URL="http://localhost:6334" \
    QDRANT_CLUSTER_0_API_KEY="" \
    DISABLE_API_KEY_CHECK=true \
    "$CORE_BIN" &
    sleep 2
    ok "Core API started on :3001"
  fi
fi

# ---- OAuth Service ----
OAUTH_BIN="$ROOT_DIR/core/target/release/oauth"
if [ -z "${OAUTH_ENCRYPTION_KEY:-}" ]; then
  warn "OAUTH_ENCRYPTION_KEY not set in .env. OAuth tools (Gmail, etc.) won't work."
elif [ ! -f "$OAUTH_BIN" ]; then
  warn "OAuth binary not built. Run: cd core && cargo build --release --bin oauth"
elif lsof -iTCP:3003 -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  ok "OAuth service already running on :3003"
else
  log "Initializing OAuth tables..."
  OAUTH_DATABASE_URI="${FRONT_DATABASE_URI}" \
    "$ROOT_DIR/core/target/release/init_db" 2>/dev/null || true
  log "Starting OAuth service..."
  OAUTH_DATABASE_URI="${FRONT_DATABASE_URI}" \
  OAUTH_ENCRYPTION_KEY="${OAUTH_ENCRYPTION_KEY}" \
  OAUTH_GOOGLE_DRIVE_CLIENT_ID="${OAUTH_GOOGLE_DRIVE_CLIENT_ID:-}" \
  OAUTH_GOOGLE_DRIVE_CLIENT_SECRET="${OAUTH_GOOGLE_DRIVE_CLIENT_SECRET:-}" \
  REDIS_URI="${REDIS_URI}" \
  DISABLE_API_KEY_CHECK=true \
  OAUTH_PORT=3003 \
  "$OAUTH_BIN" &
  sleep 2
  ok "OAuth service started on :3003"
fi

# ---- Temporal Worker ----
log "Starting Temporal workers..."
cd "$FRONT_DIR"
bash ./admin/dev_worker.sh &
sleep 3
ok "Temporal workers started"

# ---- Next.js ----
log "Starting Next.js on :3011..."
npx next dev --port 3011 &
sleep 3

echo ""
ok "========================================="
ok " All services running!"
ok ""
ok " App:      http://localhost:3011"
ok " OAuth:    http://localhost:3003"
ok " Temporal: http://localhost:8233"
ok ""
ok " Ctrl+C to stop everything"
ok "========================================="
echo ""

wait

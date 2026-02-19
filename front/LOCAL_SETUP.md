# Dust Front — Local Development Setup

## Prerequisites

- Docker & Docker Compose
- Node.js 20.x
- [Rust toolchain](https://rustup.rs/) (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- [Temporal CLI](https://docs.temporal.io/cli) (`brew install temporal`)

## 1. Environment files

Copy the example env and fill in values:

```bash
cp front/.env.example front/.env
```

The repo root also needs a `.env` for docker-compose (Elasticsearch/Kibana config):

```
ES_LOCAL_VERSION=8.13.4
ES_LOCAL_CONTAINER_NAME=dust-elasticsearch
ES_LOCAL_PORT=9200
ES_LOCAL_HEAP_INIT=512m
ES_LOCAL_HEAP_MAX=512m
ELASTICSEARCH_PASSWORD=changeme
KIBANA_LOCAL_CONTAINER_NAME=dust-kibana
KIBANA_LOCAL_PORT=5601
KIBANA_LOCAL_PASSWORD=changeme
KIBANA_ENCRYPTION_KEY=a-random-32-char-encryption-key!
```

### Critical env vars

These are the non-obvious ones that tripped us up:

| Variable | Value | Why |
|----------|-------|-----|
| `ACTIVATE_ALL_FEATURES_DEV` | `true` | Without this, every page redirects to itself in an infinite SPA redirect loop |
| `REGION` | `us-central1` | Required at runtime, not in the main config file |
| `WORKOS_API_HOSTNAME` | `api.workos.com` | Dust hardcodes `auth-api.dust.tt` (their custom domain). Override for local dev |
| `NOVU_SECRET_KEY` | any stub value | `/api/user` crashes without it, causing redirect loops |
| `NEXT_PUBLIC_NOVU_API_URL` | `https://api.novu.co` | Required client-side for notifications |
| `NEXT_PUBLIC_NOVU_APPLICATION_IDENTIFIER` | any stub value | Required client-side for notifications |
| `NEXT_PUBLIC_NOVU_WEBSOCKET_API_URL` | `https://ws.novu.co` | Required client-side for notifications |
| `DUST_MANAGED_GOOGLE_AI_STUDIO_API_KEY` | your Google AI Studio key | Used by the Temporal worker for LLM calls. Worker reads this from env, NOT from the per-workspace provider config in the UI |

## 2. Start Docker infra

```bash
docker compose up -d
```

Services: Postgres (`:5432`), Redis (`:6379`), Elasticsearch (`:9200`), Qdrant (`:6333`/`:6334`), Tika (`:9998`), Kibana (`:5601`).

## 3. Install dependencies

```bash
npm install
```

## 4. Build workspace packages

Sparkle (design system) and the JS SDK must be built before Next.js can compile:

```bash
cd sparkle && npm run build && cd ..
cd sdks/js && npm run build && cd ../..
```

## 5. Build the Core API (Rust)

The `core/` directory is a Rust service that handles tokenization. **Every LLM call goes through it** — the agent loop will fail without it.

```bash
cd core
cargo build --release
```

> **Note:** First build takes ~9 minutes. Subsequent builds are faster.

## 6. Create and initialize the database

```bash
docker exec <db-container-name> psql -U dev -c "CREATE DATABASE dust_front;"
cd front
FRONT_DATABASE_URI="postgres://dev:dev@localhost:5432/dust_front" ALLOW_UNSAFE_INITDB=true npx tsx admin/db.ts
```

> **Note:** The `initdb` npm script doesn't load `front/.env` automatically, so `FRONT_DATABASE_URI` must be passed explicitly.

## 7. Seed plans and create a subscription

After first login via WorkOS, your workspace will exist but have no subscription, causing a redirect loop (`/` -> `/trial` -> `/subscribe` -> `/`).

### Seed plans

```bash
cd front
FRONT_DATABASE_URI="postgres://dev:dev@localhost:5432/dust_front" npx tsx -e "
  const { upsertFreePlans } = require('./lib/plans/free_plans');
  upsertFreePlans().then(() => console.log('Plans seeded')).catch(console.error);
"
```

### Create a subscription

Find your workspace ID:
```bash
docker exec <db-container-name> psql -U dev -d dust_front -c "SELECT id, \"sId\" FROM workspaces;"
```

Then create a subscription with `FREE_UPGRADED_PLAN` (plan ID 2, which has `canUseProduct: true`):
```sql
INSERT INTO subscriptions ("sId", "workspaceId", "planId", status, "startDate", "createdAt", "updatedAt")
VALUES ('sub_local_dev_001', <workspace_id>, 2, 'active', NOW(), NOW(), NOW());
```

### Flush the Redis subscription cache

Subscriptions are cached in Redis for 30 minutes. After inserting, flush it:
```bash
docker exec <redis-container-name> redis-cli DEL "cacheWithRedis-_fetchActiveByWorkspaceModelIdUncached-subscription:active:workspaceId:<workspace_id>"
```

## 8. Start Temporal

```bash
temporal server start-dev &
```

Temporal UI available at `http://localhost:8233`.

### Register custom search attributes

The agent loop workflows use custom search attributes that must be registered before any conversation will work:

```bash
temporal operator search-attribute create --name workspaceId --type Text
temporal operator search-attribute create --name conversationId --type Text
```

## 9. Start the Core API

In a separate terminal:

```bash
cd core
CORE_DATABASE_URI="postgres://dev:dev@localhost:5432/dust_front" \
ELASTICSEARCH_URL="http://localhost:9200" \
ELASTICSEARCH_USERNAME="elastic" \
ELASTICSEARCH_PASSWORD="changeme" \
QDRANT_CLUSTER_0_URL="http://localhost:6334" \
DISABLE_API_KEY_CHECK=true \
./target/release/core-api
```

Runs on port 3001 by default (set `CORE_PORT` to override).

> **Important:** `DISABLE_API_KEY_CHECK=true` skips API key validation — only for local dev.

## 10. Start the front-end

```bash
cd front
npx next dev --port 3011
```

App available at `http://localhost:3011`.

> **Important:** Must be port 3011 — Dust hardcodes `localhost:3011` as the dev app URL in `lib/auth/appServerSideProps.ts`.

## 11. Start the Temporal worker (needed for agent loop / LLM calls)

In a separate terminal. The worker needs `front/.env` loaded explicitly:

```bash
cd front
set -a && source .env && set +a
bash ./admin/dev_worker.sh
```

> **Important:** `tsx` (used by the worker script) does NOT auto-load `.env`, so you must source it manually. Without `DUST_MANAGED_GOOGLE_AI_STUDIO_API_KEY` in the environment, the worker will crash on the first LLM call.

## 12. Configure LLM providers (UI)

Per-workspace provider keys are configured through the UI (separate from the managed env var keys):

1. Go to `http://localhost:3011/w/<workspace_sId>/developers/providers`
2. Add your Anthropic, OpenAI, or Google AI Studio API key

> **Note:** The `DUST_MANAGED_*` env vars (step 11) are used by the Temporal worker for managed model access. The UI provider keys are for workspace-level access. Both may be needed.

## Auth (WorkOS)

Login requires [WorkOS](https://dashboard.workos.com) (free dev tier).

1. Create a WorkOS account and project
2. Fill in the `WORKOS_*` values in `front/.env`
3. Set `WORKOS_API_HOSTNAME=api.workos.com` (overrides Dust's custom domain)
4. Set the redirect URI in WorkOS dashboard to `http://localhost:3011/api/workos/callback`

## Ports

| Service       | Port |
|---------------|------|
| Next.js       | 3011 |
| Core API      | 3001 |
| Postgres      | 5432 |
| Redis         | 6379 |
| Elasticsearch | 9200 |
| Qdrant        | 6333/6334 |
| Tika          | 9998 |
| Kibana        | 5601 |
| Temporal      | 7233 |

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Infinite redirect loop (`/trial` -> `/subscribe` -> `/`) | No subscription or plan in DB | Seed plans + create subscription (step 7) |
| Infinite redirect loop (same page redirects to itself) | Missing `ACTIVATE_ALL_FEATURES_DEV` | Add `ACTIVATE_ALL_FEATURES_DEV=true` to `.env` |
| `NOVU_SECRET_KEY is not set` crash on `/api/user` | Missing env var | Add stub `NOVU_SECRET_KEY` to `.env` |
| `REGION is required but not set` | Not in main config, lives in `lib/api/regions/config.ts` | Add `REGION=us-central1` to `.env` |
| WorkOS `invalid_client` error | Redirecting to `auth-api.dust.tt` | Set `WORKOS_API_HOSTNAME=api.workos.com` |
| Port 3000 redirects to 3011 | Hardcoded dev URL in `appServerSideProps.ts` | Run on port 3011 |
| Subscription changes not taking effect | Redis caches subscriptions for 30 min | Flush Redis cache (step 7) |
| `gemini-pro` not found when adding Google AI Studio | Deprecated model in provider check | Update model in `pages/api/w/[wId]/providers/[pId]/check.ts` to `gemini-2.5-flash` |
| `@dust-tt/sparkle` or `@dust-tt/client` not found | Workspace packages not built | Build sparkle and sdks/js (step 4) |
| `Element type is invalid` | Stale `.next` cache | Delete `front/.next/` and restart |
| `Unexpected network error from CoreAPI: fetch failed` | Core Rust API not running | Build and start core-api (steps 5 + 9) |
| `DUST_MANAGED_GOOGLE_AI_STUDIO_API_KEY is required` | Worker missing managed LLM key | Source `.env` before starting worker (step 11) |
| Temporal workflow fails with missing search attribute | Custom attributes not registered | Run `temporal operator search-attribute create` (step 8) |
| Agent stuck on "thinking" forever | Temporal worker not running, or core-api down | Start worker (step 11) + core-api (step 9) |

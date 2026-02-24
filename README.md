# kaizen-dedup-fix

DB-backed message dedup fix for the `guzus/office` backend.

## Problem

`routedEventCache` was a plain `new Map()` — wiped on every process restart.
This caused agents to replay their last `send_message` on re-initialization,
producing duplicate delivery loops (Jin 4x, Dev 3x, Scout post-retirement).

## Fix

Six targeted patches to `packages/backend/dist/index.js`:

| # | Target | Change |
|---|--------|--------|
| 1 | `reconcileAgentStatesOnStartup` | Skip agents with `status=stopped` — no forced reset to idle |
| 2 | `ensureAgentStarted` | Hard-block if `agent.status=stopped` — throw, no silent restart |
| 3 | `initSchema` | `CREATE TABLE message_dedup (dedup_key TEXT PK, seen_at_ms BIGINT)` + startup prune |
| 4 | `shouldRouteMessage` | Promote to `async` |
| 5 | `shouldRouteMessage` | After in-memory pass: DB SELECT → reject if within TTL, else UPSERT |
| 6 | `communicate()` | `await shouldRouteMessage(...)` (was sync) |

## Survival guarantee

On restart:
1. `initSchema` runs → `message_dedup` table created (idempotent)
2. Stale entries older than 72h pruned
3. First `send_message` call hits DB: if key exists and `seen_at_ms` is within 30-min TTL → rejected
4. In-memory `Map` is a fast-path cache; DB is the authoritative cross-restart store

## Fallback

If DB is unavailable, the `try/catch` in patch 5 swallows the error and falls through to the existing in-memory guard. No regression.

## Applied to

`guzus/office` — `packages/backend/dist/index.js`

# kaizen-dedup-fix

DB-backed message deduplication fix for the multi-agent duplicate delivery loop.

## Root Cause

Agents session-replay their last outbound `send_message` on re-initialization.
The prior in-memory `Map` dedup cache was wiped on every restart — exactly when
the replay fires — making it useless.

## Fix

**`src/message-dedup.ts`** — DB-backed dedup module (no schema migration needed):
- Queries the existing `messages` table for identical `(toAgentId, content)` pairs
  within a 72-hour window before allowing delivery
- Normalizes whitespace before hashing so minor formatting differences don't bypass
- Fails open on DB error (never blocks agents)
- Survives restarts because it reads from PostgreSQL, not process memory

**`src/manager.patch.ts`** — Four patches to `packages/backend/src/agents/manager.ts`:
1. `ensureAgentStarted`: hard-block if `agent.status === 'stopped'`
2. `reconcileAgentStatesOnStartup`: skip stopped agents (was promoting all `thinking/executing` → `idle`)
3. `sendMessageToAgent`: call `isDuplicateMessage()` before inserting message + triggering loop
4. `registerSendMessageHandler`: block inter-agent delivery to stopped agents

**`src/scheduler.patch.ts`** — Two patches to `packages/backend/src/scheduler/jobs.ts`:
1. `pickAssignee`: filter stopped agents before role matching
2. `resumeAssignedInProgressTasksAfterRestart`: skip stopped agents on startup

## Verification

Fix survives restart because dedup state lives in PostgreSQL `messages` table,
not in process memory. On restart:
1. Scheduler calls `resumeAssignedInProgressTasksAfterRestart`
2. For each in-progress task, it would normally send a resume message
3. `sendMessageToAgent` calls `isDuplicateMessage(agentId, content)`
4. Query finds the identical resume message already delivered → drops it
5. No duplicate delivery

## Applied To

- `guzus/office` main branch
- Files: `packages/backend/src/agents/manager.ts`, `packages/backend/src/scheduler/jobs.ts`

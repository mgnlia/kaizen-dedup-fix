#!/usr/bin/env bun
/**
 * kaizen-dedup-fix/patch.js
 *
 * Applies DB-backed message dedup + stopped-agent guards to
 * packages/backend/dist/index.js in the guzus/office monorepo.
 *
 * Usage (from repo root):
 *   bun kaizen-dedup-fix/patch.js
 *
 * Idempotent — safe to re-run (all replacements are exact-match).
 */

import { readFileSync, writeFileSync } from "fs";

const TARGET = "packages/backend/dist/index.js";

let src = readFileSync(TARGET, "utf8");

let appliedCount = 0;

function applyPatch(name, oldStr, newStr) {
  if (!src.includes(oldStr)) {
    // Already applied or source changed — check for new string
    if (src.includes(newStr)) {
      console.log(`${name}: already applied, skipping`);
      return;
    }
    console.error(`${name}: MISS — neither old nor new string found`);
    process.exit(1);
  }
  src = src.replace(oldStr, newStr);
  appliedCount++;
  console.log(`${name}: OK`);
}

// ── PATCH 1 ─────────────────────────────────────────────────────────────────
// reconcileAgentStatesOnStartup: skip stopped agents
applyPatch(
  "PATCH 1 — reconcile skip stopped",
  `if (!staleStatuses.has(agent.status))
      continue;`,
  `if (!staleStatuses.has(agent.status) || agent.status === "stopped")
      continue;`
);

// ── PATCH 2 ─────────────────────────────────────────────────────────────────
// ensureAgentStarted: hard-block stopped agents
applyPatch(
  "PATCH 2 — ensureAgentStarted stopped guard",
  `async function ensureAgentStarted(agentId) {
  if (runningAgents.has(agentId))
    return;`,
  `async function ensureAgentStarted(agentId) {
  if (runningAgents.has(agentId))
    return;
  const _stoppedCheck = await getAgent(agentId);
  if (_stoppedCheck && _stoppedCheck.status === "stopped") {
    throw new Error("Cannot start stopped agent " + agentId + " — explicitly stopped, requires manual restart");
  }`
);

// ── PATCH 3 ─────────────────────────────────────────────────────────────────
// initSchema: create message_dedup table + startup prune
applyPatch(
  "PATCH 3 — message_dedup table creation",
  `  } catch {}\n}\nasync function closeDb()`,
  `  } catch {}
  await db.query(\`CREATE TABLE IF NOT EXISTS message_dedup (dedup_key TEXT PRIMARY KEY, seen_at_ms BIGINT NOT NULL)\`);
  await db.query("CREATE INDEX IF NOT EXISTS idx_message_dedup_seen ON message_dedup(seen_at_ms)");
  await db.query("DELETE FROM message_dedup WHERE seen_at_ms < $1", [Date.now() - 72 * 60 * 60 * 1000]);
}
async function closeDb()`
);

// ── PATCH 4 ─────────────────────────────────────────────────────────────────
// shouldRouteMessage: promote to async
applyPatch(
  "PATCH 4 — shouldRouteMessage async",
  `function shouldRouteMessage(fromAgentId, toAgentId, rawMessage) {`,
  `async function shouldRouteMessage(fromAgentId, toAgentId, rawMessage) {`
);

// ── PATCH 5 ─────────────────────────────────────────────────────────────────
// shouldRouteMessage: DB check+upsert after in-memory cache set
applyPatch(
  "PATCH 5 — DB dedup persistence",
  `  routedEventCache.set(dedupKey, nowMs);\n  const loopRouteKey`,
  `  routedEventCache.set(dedupKey, nowMs);
  try {
    const _dedupDb = await getDb();
    const _dedupRows = (await _dedupDb.query("SELECT seen_at_ms FROM message_dedup WHERE dedup_key = $1", [dedupKey])).rows;
    if (_dedupRows.length > 0 && (nowMs - Number(_dedupRows[0].seen_at_ms)) <= ROUTING_DEDUP_TTL_MS) {
      return { shouldDeliver: false, message: "Message deduplicated (DB): repeated payload ignored (task " + (meta.taskId ?? "n/a") + ", seq " + (meta.seq ?? "n/a") + ")" };
    }
    await _dedupDb.query("INSERT INTO message_dedup (dedup_key, seen_at_ms) VALUES ($1, $2) ON CONFLICT (dedup_key) DO UPDATE SET seen_at_ms = $2", [dedupKey, nowMs]);
  } catch (_e) { /* DB dedup unavailable — in-memory guard still active */ }
  const loopRouteKey`
);

// ── PATCH 6 ─────────────────────────────────────────────────────────────────
// communicate(): await the now-async shouldRouteMessage
applyPatch(
  "PATCH 6 — await shouldRouteMessage",
  `  const routingDecision = shouldRouteMessage(callerAgentId, args.targetAgentId, normalizedMessage);`,
  `  const routingDecision = await shouldRouteMessage(callerAgentId, args.targetAgentId, normalizedMessage);`
);

writeFileSync(TARGET, src);
console.log(`\nAll patches applied (${appliedCount} new). Written to ${TARGET}`);

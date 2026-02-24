/**
 * persistent-dedup.ts
 *
 * Fixes BLOCKER 4: In-memory dedup cache is wiped on every restart/crash,
 * which is exactly when session-replay fires. This module provides:
 *
 *  1. checkAndRecordDedup() — atomic DB-backed dedup check (INSERT ON CONFLICT)
 *  2. loadStartupDedupGuard() — pre-warms in-memory cache from DB message history
 *     on startup so session-replay is caught even after cold restart
 *  3. pruneExpiredDedup() — TTL cleanup for the message_dedup table
 *
 * Integration target in packages/backend/dist/index.js:
 *   Line 183467: var ROUTING_DEDUP_TTL_MS = 30 * 60000;
 *   Line 183478: var routedEventCache = new Map;
 *   Line 183654-183662: dedupKey check block
 *   Line 187942: startAgent (call loadStartupDedupGuard here)
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Types (mirrors the compiled bundle's internal shape)
// ---------------------------------------------------------------------------

export interface DedupMeta {
  taskId?: string | null;
  eventHash: string;
  seq?: string | null;
}

export interface DedupCheckResult {
  isDuplicate: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// DB adapter interface — injected at integration time to avoid circular deps
// ---------------------------------------------------------------------------

export interface DbAdapter {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

let _db: DbAdapter | null = null;

export function registerDbAdapter(db: DbAdapter): void {
  _db = db;
}

function getDb(): DbAdapter {
  if (!_db) throw new Error("DB adapter not registered — call registerDbAdapter first");
  return _db;
}

// ---------------------------------------------------------------------------
// In-memory L1 cache (fast path, survives within process lifetime)
// ---------------------------------------------------------------------------

const ROUTING_DEDUP_TTL_MS = 72 * 60 * 60 * 1000; // 72h — covers session-replay window
const ROUTING_DEDUP_MAX_KEYS = 10_000;

const inMemoryCache = new Map<string, number>(); // key → seenAt ms

function evictExpired(nowMs: number): void {
  for (const [key, seenAt] of inMemoryCache) {
    if (nowMs - seenAt > ROUTING_DEDUP_TTL_MS) {
      inMemoryCache.delete(key);
    }
  }
  // LRU eviction if still over limit
  while (inMemoryCache.size > ROUTING_DEDUP_MAX_KEYS) {
    const oldest = inMemoryCache.keys().next().value;
    if (oldest) inMemoryCache.delete(oldest);
  }
}

function buildDedupKey(
  fromAgentId: string,
  toAgentId: string,
  meta: DedupMeta
): string {
  return `${fromAgentId}->${toAgentId}|task:${meta.taskId ?? "none"}|hash:${meta.eventHash}|seq:${meta.seq ?? "none"}`;
}

// ---------------------------------------------------------------------------
// Content hash helper
// ---------------------------------------------------------------------------

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Core: atomic DB-backed dedup check
// ---------------------------------------------------------------------------

/**
 * Returns { isDuplicate: true } if this (from→to, contentHash) was already
 * seen within the TTL window. Otherwise records it and returns { isDuplicate: false }.
 *
 * Uses INSERT ON CONFLICT DO NOTHING so concurrent processes are safe.
 */
export async function checkAndRecordDedup(
  fromAgentId: string,
  toAgentId: string,
  meta: DedupMeta,
  ttlMs: number = ROUTING_DEDUP_TTL_MS
): Promise<DedupCheckResult> {
  const nowMs = Date.now();
  const key = buildDedupKey(fromAgentId, toAgentId, meta);

  // L1: in-memory fast path
  evictExpired(nowMs);
  const seenAt = inMemoryCache.get(key);
  if (seenAt !== undefined && nowMs - seenAt <= ttlMs) {
    return {
      isDuplicate: true,
      reason: `L1 cache hit (seen ${Math.round((nowMs - seenAt) / 1000)}s ago)`,
    };
  }

  // L2: DB check (handles restart scenario)
  const db = getDb();
  const id = `dedup_${crypto.randomBytes(8).toString("hex")}`;
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  try {
    const result = await db.query(
      `INSERT INTO message_dedup
         (id, from_agent_id, to_agent_id, content_hash, task_id, seq, seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
       ON CONFLICT (from_agent_id, to_agent_id, content_hash) DO NOTHING
       RETURNING id`,
      [
        id,
        fromAgentId,
        toAgentId,
        meta.eventHash,
        meta.taskId ?? null,
        meta.seq ?? null,
        expiresAt,
      ]
    );

    if (result.rows.length === 0) {
      // Conflict: row already existed → duplicate
      inMemoryCache.set(key, nowMs); // warm L1
      return {
        isDuplicate: true,
        reason: "DB conflict — already seen in persistent store",
      };
    }

    // Successfully inserted → not a duplicate, warm L1
    inMemoryCache.set(key, nowMs);
    return { isDuplicate: false };
  } catch (err) {
    // DB error: fall back to in-memory only (degrade gracefully)
    console.error("[dedup] DB check failed, falling back to in-memory:", (err as Error).message);
    inMemoryCache.set(key, nowMs);
    return { isDuplicate: false };
  }
}

// ---------------------------------------------------------------------------
// Startup replay guard: pre-warms cache from DB message history
// ---------------------------------------------------------------------------

/**
 * Called once at startup (after DB init, before any agent is started).
 * Reads the last 72h of outbound messages from the `messages` table and
 * pre-populates the in-memory cache.
 *
 * This is the critical fix for session-replay: the dedup cache is no longer
 * empty at the moment agents re-initialize after a restart.
 *
 * Integration point: call inside reconcileAgentStatesOnStartup() or
 * immediately after it in the startup sequence.
 */
export async function loadStartupDedupGuard(windowMs: number = ROUTING_DEDUP_TTL_MS): Promise<void> {
  const db = getDb();
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  try {
    // Load existing dedup records from persistent store
    const { rows } = await db.query(
      `SELECT from_agent_id, to_agent_id, content_hash, task_id, seq,
              EXTRACT(EPOCH FROM seen_at) * 1000 AS seen_at_ms
       FROM message_dedup
       WHERE expires_at > NOW()
         AND seen_at > $1
       ORDER BY seen_at DESC
       LIMIT 20000`,
      [windowStart]
    );

    let loaded = 0;
    for (const row of rows) {
      const key = buildDedupKey(
        String(row.from_agent_id),
        String(row.to_agent_id),
        {
          eventHash: String(row.content_hash),
          taskId: row.task_id ? String(row.task_id) : null,
          seq: row.seq ? String(row.seq) : null,
        }
      );
      inMemoryCache.set(key, Number(row.seen_at_ms));
      loaded++;
    }

    console.log(`[dedup] Startup guard loaded ${loaded} dedup records from DB (window: ${windowMs / 3600000}h)`);
  } catch (err) {
    console.error("[dedup] Failed to load startup dedup guard:", (err as Error).message);
    // Non-fatal: system continues with empty cache (same as before this fix)
  }
}

// ---------------------------------------------------------------------------
// TTL cleanup
// ---------------------------------------------------------------------------

export async function pruneExpiredDedup(): Promise<number> {
  const db = getDb();
  try {
    const result = await db.query("DELETE FROM message_dedup WHERE expires_at < NOW() RETURNING id");
    return result.rows.length;
  } catch (err) {
    console.error("[dedup] Prune failed:", (err as Error).message);
    return 0;
  }
}

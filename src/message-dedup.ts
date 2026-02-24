/**
 * DB-backed message deduplication for inter-agent message routing.
 *
 * Root cause: agents session-replay their last outbound send_message on
 * re-initialization. An in-memory Map is wiped on every restart — exactly
 * when the replay fires. This module uses the existing `messages` table
 * (PostgreSQL) as the dedup store so the check survives restarts.
 *
 * Strategy: before delivering a message, compute a stable hash of
 * (toAgentId + normalized content) and query the messages table for an
 * identical user-role message delivered to that agent within the TTL window.
 * If found, drop the delivery and log it as a duplicate.
 */

import { createHash } from "crypto";
import { getDb } from "../db/schema.js";

/** Drop duplicate messages delivered within this window (72 h). */
const DEDUP_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Compute a stable dedup key for a (recipient, content) pair.
 * Normalizes whitespace so minor formatting differences don't bypass the check.
 */
export function computeMessageHash(toAgentId: string, content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${toAgentId}::${normalized}`).digest("hex");
}

/**
 * Returns true if an identical message was already delivered to `toAgentId`
 * within the last DEDUP_TTL_MS milliseconds.
 *
 * Uses the existing `messages` table — no schema migration required.
 * The `content` column already stores the full message text; we hash it
 * in-process and compare against a hash of recent rows.
 */
export async function isDuplicateMessage(
  toAgentId: string,
  content: string
): Promise<boolean> {
  try {
    const db = await getDb();
    const since = new Date(Date.now() - DEDUP_TTL_MS).toISOString();

    // Fetch recent user messages for this agent within the TTL window.
    // Limit to 200 to keep the query fast; duplicates are almost always recent.
    const { rows } = await db.query<{ content: string }>(
      `SELECT content FROM messages
       WHERE agent_id = $1
         AND role = 'user'
         AND created_at >= $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [toAgentId, since]
    );

    const incomingHash = computeMessageHash(toAgentId, content);

    for (const row of rows) {
      const existingHash = computeMessageHash(toAgentId, row.content);
      if (existingHash === incomingHash) return true;
    }

    return false;
  } catch (err: any) {
    // On DB error, allow delivery — fail open to avoid blocking agents.
    console.warn(`[MessageDedup] DB check failed, allowing delivery: ${err?.message}`);
    return false;
  }
}

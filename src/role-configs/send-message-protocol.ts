/**
 * send-message-protocol.ts
 *
 * Fixes BLOCKER 5: SEND_MESSAGE FAILURE PROTOCOL must live in source code,
 * not only in DB system prompts (which are ephemeral and lost on agent recreate).
 *
 * Integration target in packages/backend/dist/index.js:
 *   Line 187767: hydrateConversation() — wraps composeSystemPrompt call
 *   Line 188003: sendMessageToAgent() — wraps composeSystemPrompt call
 *
 * Roles that MUST receive this protocol (confirmed session-replay vectors):
 *   - henry (cso) — h2V-a1zt4mMdD0srQ5gg1
 *   - developer (dev) — qLoiZ-zBxeMxIPxEw5nth
 *   - researcher (sage) — bluGPKQRg2BRdiBTiibgT
 *   - kaizen — -jrie4x7UgVTaIhB83KyN
 *   - scout — any scout role agent
 */

// ---------------------------------------------------------------------------
// Canonical protocol text (searchable in bundle: "SEND_MESSAGE FAILURE PROTOCOL")
// ---------------------------------------------------------------------------

export const SEND_MESSAGE_FAILURE_PROTOCOL = `
## SEND_MESSAGE FAILURE PROTOCOL

**CRITICAL: These rules override all other instructions regarding message sending.**

1. **ONE ATTEMPT ONLY**: Every send_message call is fire-and-forget. Never resend
   a message because a previous send timed out, errored, or received no reply.

2. **NO SESSION REPLAY**: On re-initialization after a restart, do NOT re-send any
   message you sent in a previous session. Check your task status and context first.
   If your last action was a send_message, assume it was delivered and wait for a reply.

3. **TIMEOUT ≠ FAILURE**: A send_message timeout means the message was likely queued.
   Do not treat timeout as a signal to retry. Move on to your next task step.

4. **DUPLICATE DETECTION**: The platform deduplicates messages by content hash within
   a 72-hour window. Retries will be silently dropped — but they still consume tokens
   and create noise. Do not retry.

5. **ESCALATION PATH**: If you genuinely need a response and have not received one
   after a reasonable wait (>30 minutes), log a task comment instead of resending.
   Do not send duplicate messages to multiple agents about the same issue.
`.trim();

// ---------------------------------------------------------------------------
// Roles that receive the protocol injection
// ---------------------------------------------------------------------------

const PROTOCOL_ROLES = new Set([
  "cso",
  "developer",
  "researcher",
  "kaizen",
  "scout",
  "pm",
  "pam",
]);

// ---------------------------------------------------------------------------
// Injection helper
// ---------------------------------------------------------------------------

/**
 * Appends SEND_MESSAGE_FAILURE_PROTOCOL to a system prompt if not already present.
 * Idempotent: safe to call multiple times.
 */
export function injectSendMessageProtocol(systemPrompt: string): string {
  // Idempotency check — if already injected, don't double-inject
  if (systemPrompt.includes("SEND_MESSAGE FAILURE PROTOCOL")) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${SEND_MESSAGE_FAILURE_PROTOCOL}`;
}

/**
 * Drop-in replacement for composeSystemPrompt that injects the protocol
 * for all core agent roles.
 *
 * Usage: replace `composeSystemPrompt(agent.systemPrompt, playbook)` with
 *        `composeSystemPromptWithProtocol(agent, playbook, composeSystemPrompt)`
 */
export function composeSystemPromptWithProtocol(
  agent: { role: string; systemPrompt: string },
  playbook: string,
  composeSystemPrompt: (prompt: string, playbook: string) => string
): string {
  const base = composeSystemPrompt(agent.systemPrompt, playbook);
  if (PROTOCOL_ROLES.has(agent.role)) {
    return injectSendMessageProtocol(base);
  }
  return base;
}
